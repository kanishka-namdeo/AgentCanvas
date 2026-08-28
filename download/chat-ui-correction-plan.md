# Chat UI Congestion & Responsiveness — Correction Plan

Based on `download/chat-ui-audit.md` (71 findings) + `download/chat-ui-best-practices.md` (12 rules).

## Implementation Order (10 highest-impact fixes, lowest risk first)

### Phase 1 — Long-content overflow (highest impact, isolated changes)
- **F1**: `src/components/canvas/AgentPanel.tsx:2356` ToolCallEntry args `<pre>` → add `max-h-48 overflow-y-auto ac-hide-scrollbar`
- **F2**: `src/components/canvas/Markdown.tsx:38` CodeBlock `<pre>` → add `max-h-64 overflow-y-auto ac-hide-scrollbar`
- **F3**: `src/components/sessions/RunHistoryPanel.tsx:745` ToolCallCard args `<pre>` → add `max-h-48 overflow-y-auto ac-hide-scrollbar`

### Phase 2 — Action button hygiene (touch + readability)
- **F4**: `src/components/canvas/AgentPanel.tsx:1834-1889` assistant hover action row → `gap-0.5`→`gap-1`, persistent on mobile (`opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100`), bump button `p-1`→`h-7 w-7 p-1.5` for tap target.
- **F5**: `src/components/canvas/AgentPanel.tsx:1733-1766` user hover action row → same pattern; add `focus-within` on parent.

### Phase 3 — Chat panel header decongestion
- **F6**: `src/components/canvas/AgentPanel.tsx:1127-1170` header → split into 2 rows on narrow widths via `flex-wrap`, bump 9/10px → 11px, move `.pen · 60+ tools` badge into a tooltip.
- **F7**: `src/components/canvas/AgentPanel.tsx:263-316` `ModelContextStatus` → reduce to 2 visible clusters (model + context%), hide cumulative-tokens behind tooltip, add `min-w-0` + `flex-shrink-0` per cluster.
- **F8**: `src/components/canvas/AgentPanel.tsx:1900-1923` turn meta footer → bump 9px → 11px, add `flex-wrap`.

### Phase 4 — Flex long-text safety
- **F9**: `src/components/canvas/AgentPanel.tsx:1645,1801` user + assistant bubble `flex-1` content → add `min-w-0` (also `break-words`/`overflow-wrap-anywhere`).
- **F10**: `src/components/canvas/AgentPanel.tsx:2356` ToolCallEntry args `<pre>` `break-all` (already there for AgentPanel; add to Markdown CodeBlock + RunHistoryPanel pre).

### Phase 5 — Responsive panel sizing
- **F11**: `src/app/page.tsx:858-895` right chat panel `minSize='20%'` → `minSize='22%'`, left sidebar `minSize='14%'` → `minSize='16%'` (modest bump; preserves canvas room).
- **F12**: `src/app/page.tsx:748` top header → add `flex-wrap` + `min-w-0` per cluster, bump right-cluster gap-1.5 → gap-2, add `flex-shrink-0` to each button.

### Phase 6 — Density token viewport gate (low risk, high coverage)
- **F13**: `src/app/globals.css:437-448` compact density remaps → wrap in `@media (min-width: 768px) { ... }` so mobile always uses comfortable density.

### Phase 7 — Popover max-width safety
- **F14**: `src/components/canvas/ModelSwitcher.tsx:271` `PopoverContent w-72` → `w-72 max-w-[calc(100vw-1rem)]`; trigger `max-w-[110px]` → `max-w-[110px] sm:max-w-[160px] lg:max-w-[200px]`.
- **F15**: `src/components/sessions/SessionHeader.tsx:126,132` `max-w-[180px]` → `max-w-[140px] sm:max-w-[200px] md:max-w-[280px]`.

### Phase 8 — Tiny text bumps (cluster of low-risk polish)
- **F16**: Bump 8/9px text → 10/11px in: `SessionSidebar.tsx` (tag chips L359/366, footer L566), `AgentPanel.tsx` (SkillChip L546, follow-ups heading L2502, queue chips L611-636, sent labels L1399/1408, etc.)
- **F17**: `src/components/sessions/StatusBadge.tsx:68` sm size 9px → 10px, `h-3.5` → `h-4`, add `py-0.5`.

### Phase 9 — Add `flex-wrap` to single-row meta clusters
- **F18**: `src/components/sessions/SessionSidebar.tsx:566` footer → `flex-wrap`; `SessionHeader.tsx:194` meta row → `flex-wrap`; `AgentPanel.tsx:2257` ToolsCluster header → `flex-wrap`.

## Verification (per phase)
- After each phase: `bun run build` (or rely on Turbopack dev HMR).
- Visual: capture screenshots at 1440px, 1024px, 768px viewports.
- Functional: send a test message, expand a tool call, hover/click action buttons, check mobile density.

## Push
- `git add -A && git commit -m "fix(chat-ui): decongest chat panel, fix responsiveness, gate compact density to desktop"` then `git push origin main`.
