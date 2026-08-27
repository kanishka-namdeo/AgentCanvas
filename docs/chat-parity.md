# Chat/Message Interface Parity Plan — Cursor-class polish for the pi-agent panel

> Task: "the chat and message interface in the agent chat doesn't match the polish and
> intuitiveness of tools like cursor etc — do online research and ensure parity, end to end,
> wrt our pi-agent feature set."

## 1. Research inputs

| Source | Key finding |
|---|---|
| Cursor 3 / 3.11 (InfoQ, DigitalApplied, forum.cursor.com) | Agent-first UI; **messages typed while the agent runs are queued by default** and sent when the turn finishes; parallel side chats; transcript search |
| cursor.com changelog (Sep 2025) | Slash commands + auto-summarization near the context limit; slash-command suggestions while typing `/` |
| forum.cursor.com (Apr 2026) | Queue follow-ups "until after the current model finishes thinking" — queueing is the expected default, NOT a disabled input |
| 21st.dev / thefrontkit / setproduct (chat UI anatomy, 2026) | A chat interface = prompt input + scrolling thread + explicit model-turn states (waiting / streaming / stopped / errored) + feedback capture + accessibility (aria-live) |
| Cline docs | Human-in-the-loop approvals, follow-up suggestions, auto-approve categories; task timeline with per-step status |
| Prior in-repo research (`research-context/*`, `download/ui-improvement-research.md`) | Context-window traffic lights (OpenCode), model badge next to input (Cursor), token usage tooltips (Claude Code `/context`) — already shipped |

## 2. Gap analysis (ours vs Cursor)

| # | Pattern (Cursor & industry) | Ours before | Action |
|---|---|---|---|
| 1 | **Queued messages** — input usable while agent runs; new prompts queue + auto-send after the turn | Textarea disabled while busy; separate one-line SteerInput | Input stays enabled; `queuedPrompts` in the canvas store, auto-flush on `agent:turn_end` / `agent:error`; queued chips in-thread with remove ×; Steer kept as explicit affordance in the busy row |
| 2 | **Live activity + elapsed timer** — status line shows what the agent is doing + for how long | Static "agent is working…" | Activity label (latest tool summary / "Thinking…") + ticking mm:ss timer + Stop + Steer toggle |
| 3 | **Inline edit & resend** of user messages (truncates what follows, like Cursor edit) | "Edit & resend" only re-sent the same text | Pencil → inline textarea → `editUserTurn` store action truncates turns + session messages after the edited prompt and re-sends |
| 4 | **Message feedback** 👍/👎 on responses (Cursor) | None | Hover thumbs on assistant turns; persisted on the session `Message` (`feedback: 'up' \| 'down'`) + live turn |
| 5 | **Streaming caret** — blinking cursor at end of streaming text (every major chat) | Text just stops mid-stream | `.ac-caret` CSS caret after the streaming markdown |
| 6 | **@-mentions** (Cursor `@file`/`@docs`) | None | `@` opens a layer-mention menu (canvas layers, fuzzy matched); inserts `@Name`; mentioned ids merge into the prompt's selection targeting |
| 7 | **Draft persistence** (Cursor keeps unsent drafts) | Input lost on reload | localStorage draft per document, debounced save, cleared on send |
| 8 | **Compact empty state** (Cursor: centered greeting + chips) | Dense explainer card + group tabs + long prompt list | Centered greeting + quick chips + one hint line |
| 9 | **Input affordances** (⏎ send · ⇧⏎ newline) | Placeholder text only | Dynamic hint row under the input (send / queue semantics) |
| 10 | **a11y on streaming thread** | Partial | `aria-live="polite"` on the conversation region |

## 3. Architecture

```
src/lib/agent/chat-mentions.ts   pure mention engine (match / apply / extract) — unit-tested
src/lib/agent/draft-store.ts     per-document draft persistence — unit-tested
src/lib/sessions/types.ts        Message.feedback field
src/lib/sessions/store.ts        truncateMessagesAfter + setMessageFeedback
src/lib/canvas/store.ts          queuedPrompts + queuePrompt/removeQueuedPrompt/_flushQueue
                                 + editUserTurn + setTurnFeedback + flush hooks in _onSync
src/components/canvas/AgentPanel.tsx  all UI (queue chips, live busy row, inline edit,
                                 mention menu, feedback buttons, empty state, caret)
src/app/globals.css              .ac-caret blink animation
tests/unit/chat-parity.test.ts   covers every behavior above
```

Design notes:

- **Queue flush points**: `agent:turn_end` (natural completion, stop, and the HTTP-fallback
  synthetic end) and `agent:error`. The duplicate-`turn_end` guard already in the reducer
  prevents double flushes. Flush pops ONE prompt and re-enters `promptAgent` (which re-arms
  `agentBusy`), so each queued message produces its own run + snapshot.
- **Edit & resend**: `editUserTurn(turnId, newText)` truncates `turns` after the user turn,
  deletes the trailing session-store messages via `truncateMessagesAfter`, then calls
  `promptAgent` with the edited text + the original images/selection. This matches Cursor's
  edit semantics (the branch after the edit is discarded in the live thread).
- **@-mentions**: pure string machinery + the same listbox keyboard pattern as the slash
  menu. `extractMentionedLayerIds` resolves `@Name` tokens against shape names at submit
  time; mentioned ids are UNION-ed with the canvas selection into the turn's `selection`
  payload — no server change needed.
- **Steer stays**: queueing (after the turn) and steering (mid-turn) are different
  operations in the pi-agent SDK; the busy row exposes Steer explicitly instead of
  guessing intent.
