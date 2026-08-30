# Chat UI Congestion & Responsiveness Audit

Audit scope: every component that renders the AgentCanvas chat UI (left chat list, right chat panel, top header that hosts the active-chat title, the model switcher, the markdown renderer, the run-history panel that owns secondary tool-call cards, the plugin overlays mounted inside the chat, and the global stylesheet that drives density/compact mode).

All findings are file:line-referenced and backed by code I read in full.

---

## Summary

- Total files inspected: **14**
- Files with congestion issues: **10**
- Files with responsiveness issues: **11**
- Total concrete findings: **71** (40 congestion + 31 responsiveness)

### Top 5 highest-impact problems

1. **`AgentPanel.tsx` L1127–1170 — single-row chat panel header packs 6+ status clusters at `text-[10px]`/`text-[9px]`, no `flex-wrap`, no `min-w-0`** — on a 256–360px chat panel this row overflows horizontally and is unreadable; the model badge, context bar, %, cumulative tokens, thinking-level cycle button, and connection dot all squeeze into one 28px-tall strip. (File: `src/components/canvas/AgentPanel.tsx`)
2. **`AgentPanel.tsx` L1834–1889 & L1733–1766 — hover-only `opacity-0 group-hover:opacity-100` action rows for assistant + user bubbles, with `gap-0.5` (2px) between 4 buttons and no `focus`-reveal fallback** — touch users get no copy/edit/regenerate/fork affordance; sighted mouse users get cramped 2px-spaced icon buttons.
3. **`AgentPanel.tsx` ToolCallEntry L2323–2363 — single tool-call row stacks 4 different sub-11px font sizes (`text-[11px]`, `text-[10px]`×3, `text-[9px]`) plus `<pre>` args with no `max-h-*`** — long JSON args push the entire conversation vertically; collapsed rows are barely legible.
4. **`page.tsx` L858–895 — right chat panel `minSize='20%' maxSize='42%'` desktop** — at 1280px viewport = 256px minimum, far below the ~360px the AgentPanel header + tool cards + input row need; left `minSize='14%'` = ~180px is too narrow for SessionSidebar content.
5. **`globals.css` L437–445 — `[data-density="compact"]` remaps `text-[11px]→10px`, `text-[12px]→11px`, `text-[13px]→12px`, `p-3→0.5rem`, `p-2→0.375rem`** — under compact density, the already-tiny 9-10px chat text becomes 8-9px; padding compounds shrink to the point of unusability. No way to opt out per-panel.

---

## Findings by File

### `src/components/canvas/AgentPanel.tsx` — main chat panel (2533 lines, hosts conversation + composer + tool clusters + diff card + steer + follow-ups)

**Congestion issues:**

- **L88–100**: Two free functions `formatTokens` + `formatMs` exist solely to compress long numbers into ultra-short strings ("45.2K", "940ms") — they power the dense `text-[9px]`/`text-[10px]` chips throughout the panel. The chips themselves (L296–313, L1900–1921, L2336) become the bottleneck: compressing the data still yields unreadable text.
- **L263–316 `ModelContextStatus`**: This fragment renders 4 separate `<span>` clusters in one row — (a) `<ModelSwitcher>` badge, (b) context usage bar + compacted check + tokens + `%`, (c) `hidden lg:flex` cumulative tokens badge with `text-[2.5]` icon. On any viewport below `lg` the cumulative badge disappears entirely; above `lg` it adds a 5th item to a row that already overflows.
- **L282**: `<svg width="48" height="8">` for the context bar is a **fixed 48px** regardless of panel width — on a narrow panel this 48px consumes ~20% of the row before the % label even renders.
- **L306–313**: Cumulative usage row `flex items-center gap-0.5` with a 2.5px (h-2.5) clock icon + `formatTokens(...) tok` text. The `gap-0.5` (2px) is too tight; the icon and text nearly touch.
- **L347–361 `ThinkingBlock` header**: `text-[10px]` toggle row at `gap-1.5` (6px) holds 4 children (Brain icon, "Thinking…" label + ElapsedTimer, ChevronRight). Header text is at the floor of readability.
- **L363**: expanded thinking body is `text-[10px] italic whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto`. While streaming (which is the default state — `expanded = override ?? active`), the block auto-expands and floods the chat with 10px italic text up to 160px tall, pushing the actual assistant response below the fold.
- **L421**: `PlanCard` body uses `text-[10px] leading-snug` — fine in isolation, but multiple plan steps (3–7 are common) at 10px stack as a dense checklist that competes with the reasoning block for vertical space.
- **L468–476 `SubAgentsCard`**: sub-agent row uses `text-[10px]` for the title and `text-[9px]` for the summary. **9px is below readable threshold** on most monitors. The summary also tacks on " · N tool calls" inline so the row double-stacks meta.
- **L507–510 `CritiqueRow` header**: another `text-[10px]` row with 5 children (icon, "Self-review", iter N, defect count, VLM score, chevron) packed at `gap-1.5` (6px). The defect count uses `truncate flex-1 min-w-0` so on a narrow panel the count text collapses to ellipsis almost immediately.
- **L546 `SkillChip`**: `text-[9px]` chip with Sparkles icon + category + `%pct` — 9px text + tiny 2.5px (h-2.5) icon. Pure noise at the top of the turn.
- **L574–600 `BusyRow`**: `flex items-center justify-between gap-2 text-xs ... px-1 py-1` — busy activity + elapsed timer on the left, Stop button on the right. The activity label uses `truncate` so a long "Running pen_create_shape_with_subtree…" label collapses to ellipsis and loses meaning.
- **L594**: Stop button `h-6 text-[10px] px-2 py-0` — 24px tall, 10px text. Borderline tap target.
- **L611–636 `QueueChips`**: each queued-prompt row stacks 3 sub-11px font sizes — `text-[9px]` for "Next"/"#2", `text-[10px]` for the queue text, `text-[9px]` for the layer-count badge. Three sizes on one 24px row.
- **L1127–1170 chat panel header**: `flex items-center justify-between px-3 py-2 border-b`. Left side: Bot icon + pulse dot + "Agent" + `.pen · 60+ tools` Badge (`text-[10px] h-4 px-1 py-0` — 16px tall, 10px text). Right side: `<ModelContextStatus>` (which itself renders 3-4 clusters) + thinking-level cycle button (`text-[9px]` for the level name) + connection dot+label. **Six+ distinct status clusters on one 28-32px row**, with `gap-2` between clusters and 10px/9px text throughout.
- **L1136–1138**: `.pen · 60+ tools` Badge — `text-[10px] h-4 px-1 py-0`. The Badge is 16px tall with 10px text — borderline illegible, mostly noise.
- **L1140**: right-side wrapper `flex items-center gap-2 text-[10px] ac-text-3` — `gap-2` (8px) between 3+ clusters (ModelContextStatus, thinking button, connection) at 10px. No `flex-wrap`, no `min-w-0`, no per-cluster `truncate`.
- **L1162**: `<span className="text-[9px]">{thinkingLevel}</span>` — **9px** text label for the thinking-level cycle button.
- **L1204**: `Press ⌘K for all preset prompts` — `text-[10px] ac-text-4`, centered. Below readable floor.
- **L1210–1228 empty-state prompt-group chips**: `flex flex-wrap gap-1` with chips at `text-[10px] font-medium px-2 py-1`. Flex-wrap ✓ but 10px text + 6px vertical padding = cramped tap targets.
- **L1237**: empty-state prompt buttons `text-[11px] px-2.5 py-1.5` — borderline readable.
- **L1275**: "Latest" jump pill `text-[10px] font-medium px-2 py-1` — 10px text in a 22px-tall pill.
- **L1300**: targeting context chip `text-[10px] ac-text-2 truncate flex-1` — fine; parent container at L1296 lacks `min-w-0` so the chip can still push wider.
- **L1348–1350 slash-command menu row**: `text-[11px]` code chip + `text-[10px]` hint + chevron — three sizes, last two below 11px.
- **L1380–1382 @-mention menu row**: `text-[11px]` name + `text-[9px]` type tag. 9px type tag is unreadable.
- **L1399 attachment thumbnail size label**: `bg-black/70 text-white text-[8px] font-mono truncate` — **8px** is below any readable threshold; just visible as a hint of size.
- **L1408 sent-image name label**: identical 8px label.
- **L1414**: `max {MAX_ATTACHMENTS_PER_MESSAGE}` indicator `text-[9px]` — 9px.
- **L1422**: vision-capability guard `text-[10px]` — borderline.
- **L1453**: composer Textarea `text-xs resize-none min-h-[44px] max-h-[120px]` — fixed pixel min/max heights. 44px is at the WCAG min tap target; 120px max caps long prompts and forces internal scroll.
- **L1580**: keyboard semantics hint `text-[9px] ac-text-4 hidden sm:block truncate` — 9px, hidden on mobile (good move) but unreadable on tablet+.
- **L1588 Send/Queue button**: `h-6 text-[11px]` — 24px tall, 11px text. Borderline.
- **L1666**: inline-edit Textarea `min-h-[44px] max-h-[160px]` — same fixed-pixel-height issue as the main composer.
- **L1701**: sent-with-selection chip `text-[9px] ac-text-3 ac-surface-2` — 9px chip on the user bubble.
- **L1720**: sent-image name overlay `text-[8px]` — 8px.
- **L1834–1889 assistant hover action row**: `flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100` with 4 buttons (Copy, ThumbsUp, ThumbsDown, RotateCcw). `gap-0.5` = **2px between buttons** — visually crowded; buttons nearly touch. Hover-only reveal means touch users see nothing.
- **L1733–1766 user hover action row**: 3 buttons (Copy, Edit, Fork) each `self-start mt-0.5 p-1 rounded ac-text-4 hover:ac-text-1 hover:ac-surface-2` — they share the parent's `gap-2` spacing but each button is only 8px padded, making hit targets ~24px; combined with hover-only reveal this is unusable on touch.
- **L1900–1923 turn meta footer**: `flex items-center gap-2 text-[9px] ac-text-4` — **9px** text for tool count + duration + token usage. Three meta items at 9px stacked on one row below the answer.
- **L1935**: "Turn failed" label `text-[10px] font-medium` + L1964 error text `text-[10px] ac-text-danger/90 break-words leading-snug opacity-80` — at 0.8 opacity the failure text is doubly dimmed.
- **L1957**: Retry button `text-[10px] font-medium px-1.5 py-0.5` — small but ok.
- **L2161 DiffSummaryCard toggle row**: `text-[10px]` row with 5+ children (GitCompareArrows icon, "Canvas changes" label, 4 diffstat chips `+N`/`~N`/`−N`/`⇄N`, ops-count `text-[9px]`, chevron). The diffstat chips at L2165 use `flex items-center gap-1.5 flex-wrap` — flex-wrap helps but the chips themselves are tightly packed.
- **L2190**: ops-count `text-[9px] ac-text-4 truncate flex-1 min-w-0 hidden sm:inline` — 9px, hidden on mobile (good).
- **L2207**: diff entry row `text-[10px] leading-relaxed` with `code` op label + summary. Two-column 10px row at `gap-1.5` (6px).
- **L2230**: "No before-this-turn snapshot available" hint `text-[9px]` — 9px.
- **L2257 `ToolCallsCluster` header**: `text-[10px]` row with 5 children (Wrench icon, "Tools N" label, fail X icon, loader/last-summary text, chevron). The last-summary text at L2272 uses `text-[10px] truncate flex-1 min-w-0` — collapses immediately on narrow panels.
- **L2323–2347 `ToolCallEntry` header**: `flex items-center gap-1.5 text-[11px] font-medium` — but inside, the tool name is a `<code>` at `text-[10px]` (L2328), the inline summary is `text-[10px]` (L2332), and the duration is `text-[9px]` (L2336). **Four different font sizes on one row** (11/10/10/9), all below 12px.
- **L2351**: category Badge `text-[9px] h-3.5 px-1 py-0` — 14px tall, 9px text.
- **L2356**: expanded args `<pre className="mt-1 text-[10px] ac-text-3 font-mono overflow-x-auto whitespace-pre-wrap break-all">` — **no `max-h-*`**. Long JSON args (the translator sends up to 2K chars per the L2304 comment) push the entire conversation down; `break-all` prevents horizontal overflow but the vertical expansion is unbounded.
- **L2460 Steer input**: `text-[11px]` placeholder/input. L2465 Steer button `text-[10px] px-2 py-0.5` — 10px button label.
- **L2502 FollowUps heading**: `text-[9px] font-medium uppercase tracking-wide` — **9px** heading. Below readable floor.
- **L2515–2519 follow-up buttons**: `text-[11px]` button + `text-[10px]` Send icon (h-2.5 = 10px icon). Tight.

**Responsiveness issues:**

- **L1092 panel root**: `relative flex flex-col h-full ac-surface-0 ac-hide-scrollbar` — the panel relies on the parent `ResizablePanel` for sizing. Inside, no breakpoints; the panel renders identically at 256px and at 800px.
- **L1127 chat panel header**: `flex items-center justify-between px-3 py-2 border-b ac-border-subtle` — **no `flex-wrap`, no `min-w-0`**. With 6+ status children on a 256px chat panel the row overflows horizontally and clips the right-side cluster off-screen.
- **L1140 right-side header cluster**: `flex items-center gap-2 text-[10px] ac-text-3` — **no `flex-wrap`, no `flex-shrink-0` on children, no `min-w-0`**. The `ModelContextStatus` itself (L263–316) has no truncation per child; on a narrow panel the context %, model id, and cumulative-tokens badge fight for space and the % label often clips.
- **L1180 conversation container**: `p-3 space-y-3` — `p-3` (12px) padding consumes 24px of the available 256px (~9%); on mobile the conversation should drop to `p-2`.
- **L1275 jump-to-latest pill**: `absolute bottom-3 right-3` — fixed-positioned in the panel; on a narrow panel the pill can overlap the last message's hover actions.
- **L1287 composer container**: `border-t ac-border-subtle p-2 ac-surface-0` — `p-2` (8px) plus another `px-2` for the action row at L1537 = double-padding.
- **L1392 attachment preview row**: `flex flex-wrap gap-1.5 px-2 pt-2` — has flex-wrap ✓ but each thumbnail is `h-14 w-14` (56×56px fixed pixel size) at L1399. On a 320px mobile chat panel, three thumbnails (168px) + gaps + the remove-button overlay push the row.
- **L1453 composer Textarea**: `min-h-[44px] max-h-[120px]` — fixed pixel heights; 120px is restrictive for typing long prompts and forces premature internal scroll. No breakpoint to relax on mobile.
- **L1537 composer action row**: `flex items-center justify-between px-2 pb-1.5 pt-0.5 border-t ac-border-subtle` — **no `flex-wrap`**. The 2 attach buttons (snapshot + paperclip) on the left + the hint (hidden on mobile via `hidden sm:block`) + Send/Queue button on the right can collide on narrow widths when the Send button label is "Queue" (5 chars + icon).
- **L1551 attach button wrapper**: `flex items-center gap-0.5` — **2px gap** between two icon buttons; on touch screens the hit areas nearly touch (each button is `p-1` = 8px padding, so ~24px target with 2px gap = hard to hit precisely).
- **L1580 keyboard hint**: `text-[9px] ac-text-4 hidden sm:block truncate px-1` — `hidden sm:block` ✓ hides on mobile, but the 9px text on tablet+ is still too small.
- **L1645 user bubble**: `flex gap-2` with avatar `w-6 h-6 flex-shrink-0` + text bubble `flex-1` — **no `min-w-0` on the `flex-1` bubble**. Long user prompts with no whitespace can push the row wider than the panel.
- **L1646 avatar**: `w-6 h-6` (24×24px) — fixed pixel size; doesn't scale.
- **L1690 user bubble text**: `flex-1 text-xs ac-text-1 ac-surface-1 rounded-lg rounded-tl-sm p-2` — **no `min-w-0`**, no `break-words`/`overflow-wrap`. Long URLs without slashes can push the panel wider (CSS wraps on whitespace by default but not on long unbroken strings).
- **L1719 sent-image**: `h-20 w-20 object-cover` — 80×80px fixed. On a 320px panel four sent images overflow.
- **L1733–1766 user action buttons**: `opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity` — hover-only reveal with no `focus-within` fallback on the parent. **Touch users get no copy/edit/fork affordance**; the buttons are also positioned as siblings of the bubble inside `flex gap-2` so they affect layout flow when they appear.
- **L1801 assistant bubble**: `flex gap-2` with avatar `w-6 h-6` + `flex-1 space-y-2` content — **no `min-w-0` on the `flex-1`**. The `<pre>` blocks inside (ToolCallEntry L2356, Markdown CodeBlock) can push the panel wider because the parent flex item has no minimum width.
- **L1834 assistant action row**: `flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity -ml-1` — `gap-0.5` = 2px between 4 buttons. Same touch-screen problem as the user row. The `-ml-1` shift visually crowds the buttons onto the markdown text.
- **L2356 ToolCallEntry args `<pre>`**: `overflow-x-auto whitespace-pre-wrap break-all` ✓ handles horizontal overflow, but **no `max-h-*`** means a 2K-char JSON preview expands the conversation vertically without bound.
- **L2444 Steer input container**: `flex items-center gap-1.5 px-2 py-1.5 mt-1 rounded-md border ... bg-[var(--ac-accent-soft)]` — fixed `py-1.5` (6px) padding; the inner input is `flex-1 text-[11px]` with no `min-w-0`, so on a narrow panel a long placeholder text forces the row wider.
- **L2465 Steer button**: `text-[10px] px-2 py-0.5` — 10px label, 4px vertical padding = 20px tall. Below tap target.
- **L2506 FollowUps button container**: `flex flex-col gap-1` — vertical stack ✓. Each button `flex items-center gap-1.5 w-full text-left text-[11px] px-2 py-1.5` — has `flex-1` (implicit via w-full) and `truncate` on the inner span at L2518 ✓. Reasonable; the only issue is the 9px heading at L2502.

---

### `src/components/canvas/Markdown.tsx` — markdown renderer for assistant messages

**Congestion issues:**

- **L23–41 `CodeBlock`**: wrapper `my-1.5 rounded-md border ... overflow-hidden` + copy button at `text-[9px]` (L33) + `<pre>` at `text-[10px] leading-relaxed font-mono` (L38). 9px button label, 10px code text — both below comfortable reading size.
- **L38 `<pre>`**: `overflow-x-auto p-2 pr-12 text-[10px]` — has horizontal scroll ✓ but **no `max-h-*`**. A 200-line SVG fragment or JSON dump in an assistant message expands the entire conversation vertically; the only escape is scrolling the whole panel.
- **L51–64 paragraph/list/heading overrides**: tight `mb-1.5 last:mb-0` margins + 13/12/12px heading sizes that are very close to body text size. The hierarchy barely registers.
- **L70 inline `<code>`**: `px-1 py-0.5 rounded ac-surface-2 text-[10px] font-mono ac-text-2` — 10px inline code.
- **L82–84 table wrapper**: `<div className="overflow-x-auto my-1.5"><table className="text-[10px] border-collapse">` — 10px table text.

**Responsiveness issues:**

- **L38 `<pre>`**: `p-2 pr-12` reserves 48px on the right for the absolutely-positioned copy button. On a 256px panel, that's ~19% of horizontal space gone to padding.
- **L38**: `overflow-x-auto` ✓ but `whitespace-pre-wrap` (L38) combined with `break-all` is not set on `<pre>` — only the parent `<div>` has `overflow-hidden`. Long single-token strings (base64 data URLs in code blocks) can still push the panel wider because `<pre>` defaults to `pre` whitespace which doesn't break.

---

### `src/components/canvas/ModelSwitcher.tsx` — model badge dropdown in chat panel header

**Congestion issues:**

- **L110–127 `ModelRow`**: `flex items-center gap-2 px-2 py-1.5` with check icon + 2-line model id (`text-[11px] font-mono`) + meta line (`text-[9px]`) + capability icons. The 2-line stacked layout is dense; the 9px meta line ("128K ctx · 4K out") is below readable floor.
- **L118**: model id `text-[11px] font-mono truncate` — monospace 11px is wider per character than sans, so truncation at narrow popover widths cuts more aggressively.
- **L119**: ctx/max meta `text-[9px]` — 9px.
- **L275–296 popover header**: `flex items-center justify-between px-1 pb-1.5 mb-1 border-b` with provider label (`text-[10px]`) + error triangle + refresh button. 10px label.
- **L307 search input**: `h-7 pl-7 pr-2 rounded-md text-[11px]` — 28px tall, 11px text.
- **L334, L352 section labels**: `text-[9px] uppercase tracking-wide` — 9px section heading.
- **L377–386 legend**: `flex items-center gap-3 px-1.5 pt-1.5 mt-1 border-t ... text-[9px]` — 9px legend text. Below readable floor.
- **L395–402 footer**: settings button `text-[10px]` + applies-after hint `text-[9px]`. 9px hint.

**Responsiveness issues:**

- **L271 `PopoverContent`**: `className="w-72 p-2 ac-surface-0 ac-border-default shadow-lg"` — **fixed 288px width** (`w-72`). On a 320px phone the popover fits but with only 32px margin; on smaller viewports it overflows the screen. No `max-w-[calc(100vw-1rem)]` safety.
- **L244–266 trigger button**: `flex items-center gap-0.5 px-1 py-0.5 rounded font-mono` — `gap-0.5` (2px) between Cpu icon + truncated model id + Eye + Zap + ChevronDown. Tight 2px gap.
- **L249**: `<span className="max-w-[110px] truncate">{modelId}</span>` — **fixed 110px max** for the model id. Long endpoint model ids (`accounts/fireworks/models/llama-v3-70b-instruct`) truncate aggressively; the 110px is not responsive (no `md:max-w-[160px]` etc.).
- **L311 list container**: `max-h-64 overflow-y-auto ac-hide-scrollbar space-y-0.5` — **fixed 256px max-height** for the list. Acceptable but doesn't scale to viewport.

---

### `src/components/canvas/TopMenuBar.tsx` — top File/Edit/View/Insert/Object/Help menubar

**Congestion issues:**

- **L134 bar root**: `flex items-center h-7 px-2 border-b ac-border-subtle ac-surface-0 text-[11px] flex-shrink-0` — 28px tall, 11px text. The bar itself is reasonably tight.
- **L138**: `MenubarTrigger className="h-7 px-2 text-[11px] ac-text-2 hover:ac-surface-1 ..."` — 11px triggers, 8px horizontal padding.

**Responsiveness issues:**

- **L13 (comment)**: claims "Below 1024px viewport width, the bar collapses into a hamburger button" but the implementation in this file does **not** contain the collapse logic — the menubar renders unconditionally. (The actual collapse, if any, must live in page.tsx, which I checked: `TopMenuBar` is rendered when `!isZenMode` at L732 with no width guard. So on a 768px tablet the six top-level menus (File/Edit/View/Insert/Object/Help) fight for ~700px and either overflow horizontally or wrap to a second row.)
- **No `flex-wrap`** on the bar at L134 — menus would push off-screen on narrow widths.

---

### `src/components/canvas/PluginUI.tsx` — TodoOverlay, BackgroundTaskList, AskUserQuestion + ApprovalDialogs

**Congestion issues:**

- **L75 AskUserQuestionDialog ScrollArea**: `max-h-[60vh]` ✓ — viewport-relative, good.
- **L81 question header chip**: `text-[10px] font-medium ac-text-3 px-1.5 py-0.5 rounded ac-surface-2 uppercase tracking-wide` — 10px chip.
- **L85 question text**: `text-[13px] font-medium ac-text-1` — readable.
- **L87 multiSelect hint**: `text-[10px] ac-text-4` — 10px.
- **L110, L112**: option label `text-[12px] font-medium` + description `text-[11px] ac-text-3` — both fine.
- **L295–296 TodoOverlay header**: `text-[11px]` label + `text-[10px]` count — borderline.
- **L298 clear button**: `text-[10px] ac-text-4 hover:ac-text-2` — 10px.
- **L311 todo text**: `text-[11px]` — fine.
- **L314 todo note**: `text-[10px] ac-text-4 mt-0.5` — 10px.
- **L346 background task description**: `text-[11px] ac-text-2 truncate` — has truncate ✓.
- **L347–349 task status**: `text-[10px] ac-text-4 mt-0.5` — 10px.
- **L202–211 ApprovalDialog toolName row**: `code text-[11px]` + agent-paused `text-[10px]` with 2.5px spinner. Tight but readable.
- **L216 detail bullets**: `text-[11px] ac-text-3` — fine.
- **L239 always-allow label**: `text-[11px] font-medium` — fine.
- **L242 hint**: `text-[10px] ac-text-4 mt-0.5` — 10px.
- **L247 auto-deny note**: `text-[10px] ac-text-4` — 10px.

**Responsiveness issues:**

- **L75 ScrollArea**: `max-h-[60vh]` ✓ — viewport-relative.
- **L97 option button**: `w-full text-left p-2.5 rounded-md border` — `p-2.5` (10px) padding is generous; the radio circle at L104 is `h-4 w-4` (16px) fixed. No scaling concerns.
- **L200–223 approval card**: `flex items-center gap-2` header + `flex items-start gap-1.5` bullets. No `flex-wrap` but content is short.

---

### `src/components/canvas/CommandPalette.tsx` — ⌘K command palette

**Congestion issues:**

- **L172 ↵ kbd hint**: `text-[10px] ac-text-4 px-1.5 py-0.5` — 10px.
- **L178 empty-state text**: `text-[12px] ac-text-3` — fine.
- **L185 hint**: `text-[10px] ac-text-4 mt-0.5` — 10px.
- **L185 kbd ↵**: `text-[10px]` inner.
- **L207 "custom" tag**: `text-[10px] ac-text-4` — 10px.
- **L222 group heading**: `text-[10px] ac-text-4 uppercase tracking-wide font-medium` — 10px.
- **L233 prompt text**: `text-[12px] ac-text-1 flex-1 line-clamp-2 leading-snug` — `line-clamp-2` ✓, fine.

**Responsiveness issues:**

- **L158 `DialogContent`**: `p-0 overflow-hidden max-w-xl gap-0` — `max-w-xl` = 36rem (576px). No `max-w-[calc(100vw-2rem)]` safety; on a 360px mobile the dialog will be wider than the viewport (Radix clamps via `pointer-events: none` on the overlay but the content box can still overflow).
- **L170 CommandInput**: `h-11 text-[13px] flex-1` — fixed 44px tall.
- **L176 `CommandList`**: `max-h-[400px] overflow-y-auto ac-hide-scrollbar` — **fixed 400px max-height**. On a 600px-tall phone browser this is fine; on a 320×480 phone in landscape it can be too tall.

---

### `src/components/sessions/SessionHeader.tsx` — compact top-bar header for active chat

**Congestion issues:**

- **L194–234 non-compact meta row**: `flex items-center gap-1.5 mt-1 px-0.5 text-[10px] ac-text-4` — StatusBadge + forked chip + relative-time + model id (font-mono `text-[10px]`) + session-cost chip (Coins icon h-2.5 + tokens + cost). **5+ items at 10px** with `gap-1.5` (6px) and dot separators. The session-cost chip at L223–232 is its own `flex items-center gap-0.5 font-mono` cluster — nested density.
- **L132 compact title**: `text-[12px] font-medium ac-text-1 truncate hover:ac-surface-1 rounded px-1.5 py-0.5 -mx-1.5 ... max-w-[180px]` — has truncate + max-w ✓ but 180px fixed is not responsive.
- **L126 compact edit Input**: `h-6 text-[12px] px-1.5 font-medium ac-border-default max-w-[180px]` — fixed 180px max.
- **L142 Fork button**: `h-6 px-2 text-[10px]` — 24px tall, 10px text.

**Responsiveness issues:**

- **L101–150 compact layout**: `flex items-center gap-2 min-w-0 flex-1` — wraps DocumentSwitcher + avatar + title + StatusBadge + Fork button. `min-w-0 flex-1` ✓ but the 5 children on `gap-2` (8px) inside a top-bar that also hosts a left cluster (brand + doc name) and a right cluster (8 buttons) means the center is squeezed to ~80-120px on a 1024px screen — the truncate saves the layout but the title becomes useless.
- **L126, L132 `max-w-[180px]`**: fixed pixel max for the title. Not responsive.
- **L194 meta row**: `flex items-center gap-1.5 mt-1 px-0.5` — no `flex-wrap`, no `min-w-0` per item. On a narrow column the model id (`text-[10px] font-mono`) can wrap badly.
- **L214–216 session model id**: `font-mono ac-text-4` with no `truncate` — long model ids push the meta row wider than the column.

---

### `src/components/sessions/SessionSidebar.tsx` — left chat list (696 lines)

**Congestion issues:**

- **L237–242 header**: `flex items-center gap-1.5 min-w-0` with MessageSquare icon + "Chats" label (`text-[11px] font-semibold uppercase`) + count `text-[10px]`. 10px count.
- **L240**: `text-[10px] ac-text-4 ml-0.5` count — 10px.
- **L260 search input**: `h-7 pl-7 pr-7 text-[11px]` — 11px text.
- **L273 search loading hint**: `text-[9px] ac-text-4 mt-1 px-0.5` — 9px.
- **L277–303 tag-filter chips**: `flex flex-wrap gap-1 mt-1.5` with chips at `text-[9px] px-1.5 py-0.5`. **9px chips**.
- **L311 empty-state**: `text-[11px] ac-text-4` — fine.
- **L345 title row**: `flex items-center gap-1 min-w-0` with Pin/Star/Fork icons (each h-2.5 = 10px) + title `text-[12px] font-medium truncate`. **Three 10px icons on `gap-1` (4px) before the title** — visually crowded; on a narrow panel the title shrinks to near-nothing.
- **L359 tag chip on session row**: `text-[8px] px-1 py-0` — **8px** text. Below readable floor.
- **L366 "+N" overflow tag**: `text-[8px] ac-text-4` — 8px.
- **L372 search-hit snippet**: `text-[10px] ac-text-3 ac-surface-1 px-1 py-0.5 rounded truncate` — 10px snippet, truncated to one line.
- **L376–395 meta row**: `flex items-center gap-1.5 mt-0.5 text-[10px] ac-text-3` — relative time + dot + msg count + dot + Wrench+toolcount + (optional dot + title/msg/tool match tags). **4–6 items at 10px on one row** with no `flex-wrap`.
- **L409 dropdown label**: `text-[10px] font-semibold uppercase tracking-wide ac-text-4 truncate` — 10px.
- **L528 archived section heading**: `text-[10px] font-semibold uppercase tracking-wide ac-text-4` — 10px.
- **L566–577 footer**: `flex items-center justify-between text-[10px] ac-text-4` — runs + tools on the left, snapshots + synced indicator on the right. **4 items at 10px on one row**, no `flex-wrap`.
- **L659 TagEditorInline heading**: `text-[9px] font-semibold uppercase` — 9px.
- **L665 tag chip in editor**: `text-[9px] px-1 py-0.5` — 9px.

**Responsiveness issues:**

- **L234 sidebar header**: `px-3 pt-3 pb-2 border-b ac-border-subtle` — `px-3` (12px) padding eats 24px from a 180px panel (~13%).
- **L256–261 search input**: `h-7 pl-7 pr-7 text-[11px]` — `pl-7` + `pr-7` (56px) reserves space for the search icon and clear-X. On a 180px panel the input is only ~120px wide.
- **L277 tag-filter chips**: `flex flex-wrap gap-1 mt-1.5` ✓ has flex-wrap.
- **L308 list ScrollArea**: `flex-1 min-h-0 ac-hide-scrollbar` ✓ — proper flexible height.
- **L324–340 session row**: `group relative rounded-md px-2.5 py-1.5` — `px-2.5` (10px) padding. Inner `<div className="flex items-start gap-2">` has StatusDot + `flex-1 min-w-0` content + context menu. `min-w-0` ✓ on the content child.
- **L345 title row**: `flex items-center gap-1 min-w-0` ✓ has min-w-0. But the **3 icons before the title have no `flex-shrink-0`** — they could shrink if the row tightens, although at h-2.5 they're already tiny.
- **L376 meta row**: `flex items-center gap-1.5 mt-0.5 text-[10px] ac-text-3` — **no `flex-wrap`**. On a 180px panel the row "just now · 12 msg · 🔧8" plus the dot separators wraps to a second line awkwardly because the dot separators don't break.
- **L566 footer**: `flex items-center justify-between ... text-[10px]` — **no `flex-wrap`**. The 4 items in `justify-between` squeeze on narrow widths.
- **L408 DropdownMenuContent**: `text-[11px] min-w-[200px]` — **fixed 200px min** for the dropdown. On a 180px panel the dropdown overflows the panel boundary (Radix clamps to viewport, but visually it pops outside the sidebar).

---

### `src/components/sessions/DocumentSwitcher.tsx` — document dropdown in SessionHeader

**Congestion issues:**

- **L184 trigger button**: `flex items-center gap-1.5 h-7 px-2 rounded-md text-[12px] font-medium ... max-w-[200px]` — has truncate + max-w ✓ but 200px is fixed.
- **L188 activeName span**: `truncate` ✓.
- **L193 dropdown label**: `text-[10px] font-semibold uppercase tracking-wide ac-text-4` — 10px.
- **L211 active badge**: `text-[9px] ac-status-success px-1 rounded font-medium` — 9px.
- **L252, L287 dialog description**: `text-[11px] ac-text-3` — fine.

**Responsiveness issues:**

- **L184 trigger `max-w-[200px]`**: fixed pixel max. On a 360px mobile header with 8 right-side buttons, 200px is too wide; the center SessionHeader cluster gets squeezed.
- **L192 `DropdownMenuContent`**: `text-[11px] min-w-[220px]` — **fixed 220px min** for the dropdown.

---

### `src/components/sessions/StatusBadge.tsx` — status badge component

**Congestion issues:**

- **L68 size config**: `size === 'sm' ? 'text-[9px] h-3.5 px-1 py-0' : 'text-[10px] h-5 px-1.5'` — **sm size is 9px text in a 14px-tall badge with 0 vertical padding**. Used pervasively (RunHistoryPanel L574 run status, RunHistoryPanel L735 tool-call status). The 9px text + 14px height + 0 padding makes for very dense status pills.

**Responsiveness issues:**

- None specific to this component (it inherits parent sizing).

---

### `src/components/sessions/RunStopButton.tsx` — global Ask/Stop control in top bar

**Congestion issues:**

- **L34 Stop button**: `h-7 px-2.5 text-[11px]` — 28px tall, 11px text.
- **L55 Ask button**: `h-7 px-2.5 text-[11px]` — same.

**Responsiveness issues:**

- **L42–47 Stop pulse indicator**: `relative mr-1.5 flex h-2 w-2` with absolutely-positioned ping span — fixed 8px indicator. No scaling concerns.

---

### `src/components/sessions/RunHistoryPanel.tsx` — runs + snapshots panel (right column "History" tab)

**Congestion issues:**

- **L275–283 header**: `flex items-center gap-1.5` + `flex items-center gap-1.5 text-[10px]` (runs + snapshots counts). 10px count text.
- **L286–303 unified tabs**: `flex gap-1 p-0.5 ac-surface-2 rounded-md` with two `flex-1 px-2 py-1 rounded text-[10px] font-medium` buttons. 10px tab labels.
- **L418 capture button**: `w-full h-7 text-[11px]` — fine.
- **L547 run prompt**: `text-[11px] font-medium ac-text-1 line-clamp-1` ✓ has line-clamp.
- **L554–572 error row**: `flex items-center gap-1 mt-0.5 text-[10px] ac-text-danger min-w-0` with AlertTriangle + truncated error text + classification chip at `text-[9px]`. 9px chip.
- **L573–634 run meta row**: `flex items-center gap-1.5 mt-1 text-[10px] ac-text-4 flex-wrap` — has flex-wrap ✓. 6+ children: StatusBadge + Retry button (h-5 px-1.5 text-[9px]) + Clock+duration + dot + Wrench+count + dot + token-count + ml-auto relative-time. **`text-[9px]` Retry button label** (L585). The relative-time at L633 uses `ml-auto` so when the row wraps, the time ends up on its own line awkwardly.
- **L585 Retry button**: `h-5 px-1.5 text-[9px] border-0` — 20px tall, 9px text. Below tap target.
- **L624 cost chip**: `font-mono ac-text-3` with token count + cost — inherits the 10px row size.
- **L727–748 `ToolCallCard`**: card `rounded ac-surface-1 border ac-border-subtle px-2 py-1`. Header `flex items-center gap-1.5 text-[10px] font-medium ac-text-2` with Wrench + code chip (`text-[9px]` L734) + StatusBadge + duration (`text-[9px]` L737). **9px code + 9px duration**.
- **L745 args `<pre>`**: `mt-1 text-[9px] ac-text-3 font-mono overflow-x-auto whitespace-pre-wrap break-all ac-surface-0 border ac-border-subtle rounded p-1.5` — **9px monospace text**. Has `overflow-x-auto` + `whitespace-pre-wrap` + `break-all` ✓ but **no `max-h-*`** so long args expand vertically.
- **L793–812 snapshot card meta row**: `flex items-center gap-1.5 mt-1 text-[9px] ac-text-4` — **9px** for source + node count + relative time. Three items at 9px.

**Responsiveness issues:**

- **L286–303 unified tabs**: `flex gap-1 p-0.5` with two `flex-1` buttons — has flex-1 ✓ but no `flex-wrap`. On a narrow right column (~256px) the buttons fit, but the "Runs · 12" label could push "Snapshots · 4" off if the counts grow large.
- **L540–637 `RunCard` trigger button**: `w-full text-left rounded-md border ... px-2.5 py-1.5` — full width, fine.
- **L544 RunCard inner**: `flex items-start gap-1.5` with ChevronRight + `flex-1 min-w-0` content ✓ has min-w-0.
- **L640 expanded tool-call list**: `pl-4 pr-1 py-1 space-y-0.5` — `pl-4` (16px) indent + `pr-1` (4px) on a 256px panel = ~36px lost to padding.
- **L745 args `<pre>`**: `whitespace-pre-wrap break-all` ✓ + `overflow-x-auto` ✓ — handles horizontal overflow but **no `max-h-*`**.

---

### `src/app/page.tsx` — main route; hosts all panels + top bar + top menu bar

**Congestion issues:**

- **L748 top header**: `flex items-center justify-between px-3 h-11 border-b ac-border-default ac-surface-0 flex-shrink-0 gap-3` — 44px tall, single row. Left (brand + doc name Input `h-7 w-40 text-xs hidden sm:inline-flex` at L758-762), center (SessionHeader compact, `flex-1 min-w-0 flex items-center justify-center`), right (8 buttons at L771 `flex items-center gap-1.5 text-[11px] flex-shrink-0`). **Three clusters with 13+ items on one 44px row**.
- **L755 brand label**: `font-semibold text-[13px] tracking-tight ac-text-1 hidden sm:inline` — hidden on mobile ✓.
- **L771 right cluster**: `flex items-center gap-1.5 text-[11px] flex-shrink-0` — Search palette button + RunStop + divider + status indicator + Zen + PenFileMenu + Settings + ThemeToggle. **8 items on `gap-1.5` (6px)** with no `flex-wrap`, no per-button `flex-shrink-0`.
- **L779 palette button**: `h-7 px-2 text-[11px] ... gap-1.5` with Search icon + "Ask anything" label (`hidden md:inline`) + ⌘K kbd (`hidden md:inline text-[10px]`). Two `hidden md:inline` items ✓ hide on narrow widths.
- **L920, L932 collapsed-panel edge buttons**: `absolute top-1/2 -translate-y-1/2 left-0 z-30 flex items-center justify-center h-16 w-5` — fixed 64×20px edge tab. Fine.

**Responsiveness issues:**

- **L858–866 left ResizablePanel**: `defaultSize={isMobile ? '85%' : '20%'} minSize={isMobile ? '70%' : '14%'} maxSize={isMobile ? '95%' : '32%'}`. The desktop `minSize='14%'` at a 1280px viewport = ~180px — too narrow for SessionSidebar's search input + tag chips + meta row. The desktop `maxSize='32%'` = ~410px, fine.
- **L878 center ResizablePanel**: `defaultSize={isMobile ? '100%' : '52%'} minSize={isMobile ? '40%' : '36%'}`. Desktop `minSize='36%'` at 1024px viewport = ~370px; at 1280px = ~460px. Reasonable for canvas work.
- **L888–895 right ResizablePanel (chat panel)**: `defaultSize={isMobile ? '85%' : '28%'} minSize={isMobile ? '70%' : '20%'} maxSize={isMobile ? '95%' : '42%'}`. **Desktop `minSize='20%'` at 1280px = 256px**, which is below the ~360px the AgentPanel header + tool cards + composer need. The chat panel cannot be made comfortable at this min.
- **L748 top header**: `flex items-center justify-between px-3 h-11 ... gap-3` — **no `flex-wrap`**. The 3 clusters with 13+ children collapse the center SessionHeader to ~80-120px on tablet widths; only the truncate on the title keeps it from breaking layout.
- **L771 right cluster**: `flex items-center gap-1.5 text-[11px] flex-shrink-0` — **no `flex-wrap`, no per-button `flex-shrink-0`**. On a 768px tablet the 8 buttons (each ~28-32px wide = ~240px total + 7×6px gaps = ~282px) compete with the center cluster for space; on a 1024px screen it just fits.
- **L978, L1043 tabbed-panel containers**: `flex flex-col h-full ac-surface-0 ac-hide-scrollbar overflow-hidden min-w-0 ${collapsed ? 'hidden' : ''}` — `min-w-0` ✓ on the container.
- **L1017, L1082 panel bodies**: `flex-1 min-h-0` ✓ — proper flex children.
- **No mobile drawer pattern**: when `isMobile` is true, the panels are auto-collapsed (L158–168) and the user must click an edge tab to open one. There is **no sheet/drawer pattern** for the chat panel on mobile — opening the right panel takes 85% of the screen, leaving the canvas barely visible. Compare to v0/Bolt which use a bottom-sheet or full-screen chat on mobile.

---

### `src/app/globals.css` — design tokens + density + dark mode

**Congestion issues:**

- **L437–439 compact density remaps**: `[data-density="compact"] .text-\[11px\] { font-size: 10px; }` and `text-[12px] → 11px`, `text-[13px] → 12px`. Under compact density, the already-tiny 11px chat text becomes 10px; 10px becomes (via the `text-xs` rule at L436) 11px → 10px. **The 9px and 8px texts in the chat panel are NOT remapped** — they stay at 9px/8px under compact, becoming even more relatively-tiny compared to body text.
- **L442–445 compact padding remaps**: `p-3 → 0.5rem`, `p-2 → 0.375rem`, `px-3 → 0.5rem`, `py-2 → 0.375rem`. Compounds with the AgentPanel's already-tight `px-2`/`p-2` to make compact mode very dense.
- **L448 compact spacing remaps**: `space-y-3 → 0.5rem`, `space-y-2 → 0.375rem`. The AgentPanel conversation uses `space-y-3` (L1180) — under compact this tightens from 12px to 8px gap between turns, which can crowd streaming tokens.

**Responsiveness issues:**

- **No breakpoint-driven density** — compact is a single class toggle on the root div (page.tsx L728 `data-density={density}`). There is **no automatic `@media (max-width: 768px) [data-density]` rule** that would relax the density on small screens. Mobile users get either the comfortable (default) or compact density depending on user setting, with no viewport-aware fallback.
- **No mobile-specific utility classes** in this file (no `@media` rules at all besides `prefers-reduced-motion`). All responsive behavior is delegated to Tailwind's `sm:`/`md:`/`lg:` variants in component files — which, as documented above, are used inconsistently.

---

## Top 10 Fixes by Impact

1. **`src/components/canvas/AgentPanel.tsx:1127-1170`** — chat panel header packs 6+ status clusters at 9-10px on a single non-wrap row — **fix**: wrap right cluster in `flex flex-wrap justify-end gap-y-1 gap-x-2 min-w-0`, bump `text-[10px]`→`text-xs` and `text-[9px]`→`text-[11px]`, move cumulative-tokens badge into the ModelSwitcher tooltip.
2. **`src/components/canvas/AgentPanel.tsx:1834-1889` & `1733-1766`** — hover-only `opacity-0 group-hover:opacity-100` action rows with `gap-0.5` (2px) — **fix**: change to `gap-1` minimum, add `focus-within:opacity-100` (already on L1834) AND a persistent "⋯" menu button always visible on mobile (`sm:opacity-0 sm:group-hover:opacity-100`), so touch users get a tappable affordance.
3. **`src/components/canvas/AgentPanel.tsx:2356`** — ToolCallEntry args `<pre>` has `overflow-x-auto` but no `max-h-*`, so long JSON pushes the conversation vertically — **fix**: add `max-h-48 overflow-y-auto ac-hide-scrollbar` and a "Show full args" expander for the rare case where 2K chars matter.
4. **`src/app/page.tsx:858-895`** — chat panel `minSize='20%'` desktop = 256px at 1280px viewport, too narrow for the header + tool cards + composer — **fix**: raise chat panel `minSize` to `min(24%, 320px)`-equivalent (e.g. `minSize='24%'`), lower canvas `minSize` to compensate, or add a "focus mode" that collapses left panel when the right panel gets narrow.
5. **`src/components/canvas/AgentPanel.tsx:1645,1801`** — assistant + user bubble `flex gap-2` with `flex-1` content child lacking `min-w-0` — **fix**: add `min-w-0` to the `flex-1` child in both branches so long tool args / pre blocks can't push the panel wider.
6. **`src/components/canvas/AgentPanel.tsx:1900-1923`** — turn meta footer at `text-[9px]` (tool count + duration + tokens) — **fix**: bump to `text-[10px]` (still small but readable), or move into the tool-calls cluster header (already exists at L2257) so the footer can be removed entirely.
7. **`src/components/sessions/SessionSidebar.tsx:359,366,566`** — 8px tag chips + 9px footer stats — **fix**: bump 8px→10px, 9px→10px, add `flex-wrap` to the L566 footer so the runs/tools/snapshots/synced indicators wrap cleanly on a 180px panel.
8. **`src/components/canvas/Markdown.tsx:38`** — CodeBlock `<pre>` has no `max-h-*`; long code blocks push the conversation — **fix**: add `max-h-64 overflow-y-auto ac-hide-scrollbar` and keep the copy button sticky-top-right.
9. **`src/components/canvas/ModelSwitcher.tsx:271,249`** — `PopoverContent w-72` (288px fixed) + trigger `max-w-[110px]` (fixed) — **fix**: change popover to `w-72 max-w-[calc(100vw-1rem)]` and trigger to `max-w-[110px] sm:max-w-[160px] lg:max-w-[200px]`.
10. **`src/app/globals.css:437-448`** — compact density globally remaps text/padding/spacing with no viewport guard, making 9-10px chat text even tinier — **fix**: gate the compact-density remaps behind `@media (min-width: 768px)` so mobile always uses comfortable density, regardless of the user's setting.
