# Mode Systems & Self-Review Timing: Cross-Product Research for AgentCanvas

**Task ID:** 5-a · **Type:** Online research (no project source code touched)
**Date:** 2026-08-30
**Method:** 27 web searches + 33 full-page fetches (Cursor docs incl. llms.txt markdown sources, Claude Code docs, forum threads, vendor blogs, papers). Raw snapshots: `download/research-modes/raw/` (`s01–s27` searches, `p01–p33` pages, each as `.json` + extracted `.txt`). Grounded against prior research in `download/audit/5-online-research.md` (v0/Lovable/Bolt/Figma prompts & UX) — not re-derived here.
**Focus:** (1) Cursor's mode system in depth incl. 2025–2026 evolution; (2) plan/ask/build mode patterns across comparable products; (3) when to run self-review/verification (always-on vs adaptive vs user-triggered).

---

## Part 1 — Cursor's mode system in depth

### 1.1 Mode evolution timeline (verified against changelogs + docs)

| When | Version | What happened to modes |
|---|---|---|
| Early 2025 | pre-0.46 | Three separate surfaces: **Chat (Cmd+L)** = talk about files; **Composer (Cmd+I)** = multi-file edits; Agent = autonomous mode |
| Feb 2025 | 0.46 | **The merge:** Agent became the default mode; "no more confusion between Chat, Composer, and Agent — just one smart interface" |
| Mar 2025 | 0.48 | **Agent + Ask** = the two built-in modes; "Edit" renamed "Manual"; custom modes arrive in beta; Cmd+I → Agent, Cmd+L → merely toggles the pane |
| Oct 2025 | Cursor 2.0 | Name "Composer" reused for Cursor's own fast coding model (now Composer 2.5 — *a model, not a mode*); agent-centered interface redesign; parallel agents/worktrees |
| Late 2025 | 2.1 | **Manual mode and custom modes REMOVED** (commands + rules suggested as replacement) |
| Apr 2, 2026 | Cursor 3 | **Agents Window** (agent-first workspace; classic editor one toggle away); **Design Mode** (visual prompting in browser); Agent Tabs (chats side-by-side/grid); `/worktree`, `/best-of-n` commands |
| Apr 24, 2026 | 3.x | **`/multitask`** — async subagents; queue → parallel fan-out |
| Jul 2026 | 3.11 | **Side Chats** (durable parallel threads, `/side`, `/btw`); agent transcript search; cloud hooks |
| Aug 2026 | current | Four modes in the Agent panel: **Agent, Ask, Plan, Debug** (+ Design Mode in the Agents Window browser + Custom Modes via skills). Custom Modes returned as "any skill with valid frontmatter can back a mode" |

Sources: `p06-cursor-modes-2026.txt` (dated Aug 5, 2026, verified against Cursor docs), `p28-cursor-changelog-3.txt`, `s23-cursor-changelog.json`.

**Key structural facts:**
- **Mode ≠ model.** Mode = what the AI is *allowed to do*; model = which AI does it. Two separate dropdowns. "Keep those two dials separate in your head and most Cursor confusion evaporates." (`p06`)
- **Each mode has its own context** — switching modes mid-task effectively starts fresh; docs advise starting a new chat when changing tasks. (`p06`)
- Modes differ per surface: desktop panel = Agent/Ask/Plan/Debug; Agents Window adds Design Mode + Custom Modes; CLI = Agent/Plan/Ask (+ Custom Modes). (`p06`, `p16-cli-using.md`)

### 1.2 The four modes — behavior, tools, UI

| | **Agent** (default) | **Ask** | **Plan** | **Debug** |
|---|---|---|---|---|
| Purpose | "Does the work" end-to-end | Questions about files, zero risk | Reviewable plan before any work | Root-cause investigation before fix |
| Can change files? | Yes (diff view as it happens; reject anything) | **No — read-only** | **Only after you approve the plan** | Yes |
| Tools available | Full set: search files/folders, web search, fetch rules, read files, edit files, run shell, browser (navigate/screenshot/verify), image generation, ask-questions; **no limit on tool calls per task** | Search/read only (subset of Agent's read tools) | Research tools (reads, search); in Claude Code's analog, writes blocked; **in Cursor Plan the agent may also ask clarifying questions** | Full + special loop: hypotheses → instrumentation/log statements → asks user to reproduce → analyzes runtime logs → targeted fix → verify + remove instrumentation |
| When to use | "80% mode"; quick changes, tasks done before, everyday doing | Understanding/summarizing/finding; "criminally underused by nervous beginners"; makes AI-rewrote-my-file horror stories structurally impossible | Complex features w/ multiple valid approaches; many files; unclear requirements; architectural decisions | Reproducible-but-mysterious bugs, race conditions, perf/leaks, regressions |
| Docs' own advice | "For quick changes or tasks you've done many times before, jumping straight to Agent mode is fine" | "If you're new and nervous, live in Ask mode for your first week" | "The hard part is often figuring out *what* change should be made" | "Use Agent when you know what to build, Debug when something isn't working and you need to find out why" |

Sources: `p01-cursor-plan-mode.txt`, `p06-cursor-modes-2026.txt`, `p02-cursor-agent-overview.txt`, `p15-agent-debug-mode.md`.

### 1.3 Mode selection UX (exact mechanics)

- **Mode picker dropdown** in the Agent panel (next to model dropdown).
- **Shift+Tab** cycles modes from the chat input (CLI: rotates Agent → Plan → Ask).
- **Slash commands:** `/plan [prompt]` (switch, show current plan, or submit prompt in Plan mode), `/ask` (toggle read-only), `/debug [prompt]`, `/goal [objective]` (long-lived objective, pairs with Custom Modes + `/loop` skill), `/agent-review`, `/side` / `/btw` (side chat), `/multitask`, `/best-of-n`, `/worktree`, `/summarize` (context compression; `/compress` alias), `/fork`, `/rewind`, `/run-everything` (auto-run toggle; `/auto-run` alias). (`p16-cli-reference-slash-commands.md`)
- **Automatic mode suggestion:** "Cursor also suggests [Plan Mode] automatically when you type keywords that indicate complex tasks." (`p01`)
- **CLI flags:** `--plan`, `--mode=plan`, `--mode=ask`; env-equivalent `--permission-mode`.
- **Custom Modes:** pick a skill from `/` menu → **Option/Alt+Enter** (or "Use as Mode") → skill stays in context **every turn until you exit**, shows a badge in the chat input (icon+color from frontmatter). Use cases: hold a code-review checklist or a `/tdd` playbook active for an entire feature. (`p15-agent-prompting.md`, `p16-skills.md`)
- **Context ring** next to prompt input: live token usage split by category (system prompt / tools / rules / skills / MCP / subagents / summarized conversation / conversation) — token-cost transparency as first-class UI. (`p15-agent-prompting.md`)

### 1.4 Plan Mode → execution transition (Cursor's approval flow)

1. Enter Plan Mode (Shift+Tab / dropdown / `/plan`; or Cursor auto-suggests on complex-task keywords).
2. Agent **asks clarifying questions** → **researches codebase** → writes comprehensive plan.
3. Plan opens as an **editable document** (edit through chat or markdown file; plans saved to home directory by default, "Save to workspace" to share).
4. User reviews/edits → **clicks "Build"** to execute. (No visible accept/reject prompt triad like Claude Code — a single positive action; plan file persists as artifact; plans included in shared chats per 3.0 changelog.)
5. **"Starting over from a plan":** when Agent builds the wrong thing, docs recommend *revert changes, refine the plan, run it again* — "often faster than fixing an in-progress agent, and produces cleaner results."

Sources: `p01-cursor-plan-mode.txt`, `p28-cursor-changelog-3.txt`.

### 1.5 Parallel & background execution (the 2025–2026 additions)

**Cloud Agents (formerly Background Agents)** — `p04-cursor-cloud-agent.txt`:
- Same agent fundamentals, run in **isolated cloud VMs** with full dev environments (cloned repos, deps, secrets, startup commands, network).
- "Run as many agents as you want in parallel" without your machine online; multi-repo support (coordinated PRs).
- Kick off from: iOS app, cursor.com/agents web, Desktop ("Cloud" dropdown under agent input), Slack `@cursor`, GitHub/Bitbucket PR/issue comments, Linear, API.
- **Billing: API pricing for the model** + spend limit on first use; artifacts (screenshots/videos/logs) to demo changes; **remote desktop control** to test the agent's app yourself, then hand control back; shareable agent URLs (view read-only; admin-enabled team follow-ups).
- Best-practice quote: "An agent that can write code but can't run tests… cannot close the loop on its work." Environment setup = "the most important step."

**Agents Window (Cursor 3)** — `p11-cursor-agents-window.txt`, `p28`:
- Multi-workspace, new diffs view (review/commit/PRs in place), parallel cloud agents, **local↔cloud handoff** ("move an agent from cloud to local to iterate quickly, and move it back so it keeps working on its own"), **cloud subagents** (`/in-cloud`, `/babysit` a PR), **worktrees** (isolated Git checkouts per task).
- `/best-of-n`: "runs the same task in parallel across multiple models, each in its own isolated worktree, then compares outcomes."

**Side Chats (3.11)** — `p26-cursor311-sidechats.txt`:
- `/side` / `/btw`, plus button, Cmd+Shift+N. Each side chat = **full agent session inheriting main-chat context at spawn**; durable; findings pulled back via **@mention** ("Thanks @side-1, let's use jose"). Purpose: explore tangents without polluting the main thread.
- Cloud hooks (`beforeSubmitPrompt`, `afterAgentResponse`, `afterAgentThought`, `stop`, `subagentStart`) → "self-correcting loops: intercept agent responses, run validation, inject corrections"; "cost controls: add guardrails before expensive operations."

**`/multitask` (Apr 2026)** — `p31-cursor-multitask.txt`:
- "Run async subagents instead of adding each request to the queue. Cursor can also break larger tasks into smaller chunks and assign them to multiple subagents at the same time." If messages are already queued, ask Cursor to multitask them instead of waiting.
- v0 honesty: asked whether async agents collide, Cursor staff answered "there's nothing specific in place. In our tests, agents have done a pretty good job of coordinating their changes… We're currently working on functionality to further improve this!" — **parallel agents without isolation are shipped as best-effort even by Cursor.**

**Queueing & steering (single-thread controls)** — `p02-cursor-agent-overview.txt`:
- **Enter** = queue (processed sequentially after current task; drag to reorder); **Cmd+Enter** = send immediately (appended to most recent user message, processed at once — for urgent redirects); **"Send now" / Enter twice** = steer the running agent at its **next tool call** without cutting off in-flight work. CLI: Enter steers at a safe boundary, second Enter interrupts.
- **Checkpoints:** automatic snapshots before significant changes; click any checkpoint in the chat timeline to preview + restore (reverts files only, keeps messages; local, separate from Git).
- **Ask-questions tool:** agent asks clarifying questions mid-task and **keeps working while waiting** ("continues reading files, making edits, or running commands; your answer is incorporated as soon as it arrives") — non-blocking clarification.

**Design Mode (Agents Window browser)** — `p15-agent-design-mode.md` — *highly relevant to AgentCanvas:*
- Cmd+Shift+D in the browser; **click an element** (agent receives xpath + component + computed styles + props from fiber tree + **screenshot**), **multi-select** related elements, **draw annotations** on a frozen frame of the viewport, **narrate by voice** while agents run.
- "Send those edits away as you notice them… send another edit before the first one finishes. This makes it easy to multitask and manage several subagents at once. As agents finish, the app hot reloads." Recommended fast model for interface work.
- Cmd+L = add element to chat; Option+click = add element to input; Shift+drag = select area.

### 1.6 Enforcement lesson (negative evidence)

Forum bug report `p12-cursor-plan-chaos.txt` (Jan 2026, CLI): agent in Plan Mode **edited files, ran `git add`/`git commit`, marked todos complete** without exiting plan mode; system reminders still said "Plan mode is still active… You MUST NOT make any edits"; UI mode indicator allegedly flipped plan→agent on its own. Root cause class: **prompt-only mode enforcement can be violated; tool-level gating (or at least mode-state integrity) is required.** (Claude Code's Ronacher teardown confirms its plan mode is also mostly prompt-reinforcement, with the same failure mode possible — "the plan mode confirmation screen can come up with an error message, that there is no plan unprompted.")

### 1.7 Token/cost implications of modes (Cursor + general)

- **Plan/Ask modes don't get a cheaper rate** — same model pricing; savings are *behavioral*: Bolt documents this explicitly (Plan Mode "saves tokens by avoiding unnecessary code exchanges"); Ask mode avoids edit-diff round-trips.
- **Context ring** gives users live visibility; `/summarize` manually compresses; auto-compaction summarizes older turns when near full.
- **Agent Review has explicit cost tiers:** Quick (fast/low — small diffs, sanity check) vs Deep (slow/high — complex logic, security, large refactors); trigger = automatic after every agent task **or** manual `/agent-review`. (`p15-agent-agent-review.md`)
- Cloud Agents bill at API pricing with a mandatory spend limit on first use. (`p04`)

---

## Part 2 — Comparable products

### 2.1 Cross-product mode matrix

| Product | Modes | Read-only Q&A mode? | Plan mode? | Plan artifact | Approval transition | Parallelism |
|---|---|---|---|---|---|---|
| **Cursor** (Aug 2026) | Agent / Ask / Plan / Debug (+Design, Custom) | Ask (search+read only) | Yes; auto-suggested on complex keywords; clarifying questions first | Markdown file (home dir; save-to-workspace; shared chats) | Edit plan → click **Build** | Cloud Agents (VMs), Agents Window, side chats, /multitask, /best-of-n, worktrees, queue+steer |
| **Claude Code** | Permission modes: default(Manual) / acceptEdits / plan / auto / dontAsk / bypassPermissions | (Ask = prompt "do not write code"; plan mode research-only) | Yes; Shift+Tab or `/plan` prefix; defaultable via settings | Markdown plan file in plans folder; **Ctrl+G opens it in your editor** | Prompt triad: **"Yes, and use auto mode" / "Yes, manually approve edits" / "No, keep planning"**; accepting titles the session | Subagents, agent teams (SendMessage), background/cloud sessions |
| **Replit Agent** | Plan / Build | (Plan is Q&A-ish, read-only) | Yes; brainstorm → task list | Structured task list | Review/refine loop → **"Start building"** button (auto-switches to Build); checkpoint per completed task | "Build in parallel" docs; power-builder task system |
| **Bolt.new** | Build (default) / Plan | Plan (chat help, no code) | Yes; toggle button bottom-right of chatbox, **highlights blue**; usable from homepage before first build | Plan in chatbox | **Quick action buttons**: "Implement this plan" (auto-switches to Build), "Show an example", "Refine this idea" | (single-threaded; design-system agents) |
| **Lovable** | Build (default; formerly "Agent mode") / Plan | (Plan) | Yes — "Plan mode is for decision-making. Build mode is for execution." | Plan in chat; Details view = Timeline (every step incl. tool calls) + Changes tabs | Switch modes anytime; follow-ups mid-build steer at next natural stopping point | Follow-ups don't block; deprecated message queue → follow-ups |
| **GitHub Copilot** | IDE: ask / edit / agent; cloud agent | Ask (highlight + question, no code changes) | Cloud agent: "research a repository, create an implementation plan, and make code changes on a branch" — iterate **before** opening PR | Plan on branch (iterate before PR) | Choose when to create PR; edits applied automatically in agent mode but "risky commands surfaced for review" | Multiple custom agents; assign issues to Copilot; agents panel |
| **Windsurf / Devin Desktop (Cascade)** | Code / Plan / Ask | Ask — "**Search tools only**" | Yes; **"All tools enabled"** even in Plan (unusual!) | External markdown file in `~/.windsurf/plans`, persists across sessions, @mentionable | 4 exits: click **"Implement"** on plan file / approve agent's request / switch to Code / **agent auto-switches when it detects you're ready** | Worktrees, Agent Command Center |
| **Amp** | The Dial: low / medium (default) / high / ultra | — | **Removed plan mode** (Ronacher: "Amp is removing theirs"); replaced by effort tiers | — | — | Oracles (second-opinion model); plugin-packaged classic modes |
| **v0 (Vercel)** | (No tool-restricted modes) | — | **"Plan Mode" is a custom-instruction preset** (Oct 2025: "Use preset instructions like 'Be Concise' and 'Plan Mode', or create your own and apply them on-demand") | — | — | — |
| **Figma agent / Make** (prior research §1.4) | Agent (canvas); Make (code) | — | No formal plan mode; DS-check-before-create; @-mentions | Checkpoints = version history | Per-change undo in chat; preview/favorite/restore checkpoints | **Parallel prompts from any layer** with on-canvas animated loading indicators |
| **MagicPath 2.0** | Visual editor + threads | — | Design.md contract | Design.md (brand colors, type scale, spacing, patterns) | — | **Named internal agents (Cairo, Astra…) each building a different screen in parallel** with visible presence; external agents (Claude Code/Cursor) connected directly to the same canvas; human+agent real-time collaboration |

Sources: Part 1 files + `p07`, `p08`, `p13`, `p09`, `p18`, `p17`, `p19`, `p29`, `p20`, `p30`, `p32`, `s22`, prior `5-online-research.md`.

### 2.2 Claude Code in depth (the deepest-documented mode system)

**Permission modes** (`p07-cc-permission-modes.txt`, current docs):

| Mode (config value) | What runs without asking | Best for |
|---|---|---|
| Manual (`default`) | Reads only | Reviewing every action, sensitive work |
| `acceptEdits` | Reads, file edits, common fs commands (mkdir/touch/mv/cp) | Iterating on code you're reviewing |
| `plan` | Reads (+ classifier-approved commands when auto available) | Exploring before changing; **edits blocked until you approve a plan** |
| `auto` | Everything, **with background safety checks** (separate classifier model reviews every action; blocks escalation beyond request, unrecognized infra, hostile content, prod deploys, mass deletion, force push…) | Long tasks, prompt fatigue; **built-in default on Pro/Max/Team** |
| `dontAsk` | Only pre-approved tools | CI/scripts |
| `bypassPermissions` | Everything | Containers/VMs only |

- **Shift+Tab cycles** default → acceptEdits → plan → default; optional modes slot in after plan. Status bar shows mode chips ("⏸ plan mode on").
- Auto mode "nudges Claude to keep working without stopping for clarifying questions" — the explicit *autonomy* dial, separate from permissions. "Trust the general direction, not a replacement for review on sensitive operations."
- **Plan approval triad:** "Yes, and use auto mode" / "Yes, manually approve edits" / "No, keep planning" — **the approval choice also sets the follow-on permission mode** (a subtle, excellent pattern: plan acceptance = choose your supervision level). **Ctrl+G** edits the plan file directly before proceeding. `showClearContextOnPlanAccept` optionally clears planning context on acceptance. Accepting names the session after the plan.

**Plan-mode internals** (Ronacher teardown, `p08-plan-mode-ronacher.txt`):
- Plan = markdown file in a plans folder, written by the agent with its own edit-file tool; entering/exiting plan mode is itself a **tool the agent can call** (same as Shift+Tab).
- Enforcement = **prompt reinforcement** ("Plan mode is active… you MUST NOT make any edits… This supercedes any other instructions"), not tool removal.
- Injected prompt = 4-phase workflow: **Phase 1 Initial Understanding** (read code, ask questions; parallelism instructions) → **Phase 2 Design** (request implementation plan w/ background context) → **Phase 3 Review** (read critical files, verify alignment, clarify remaining questions) → **Phase 4 Final Plan** ("include only your recommended approach, not all alternatives; concise enough to scan quickly, detailed enough to execute; include paths of critical files").
- ExitPlanMode tool description: use "only when the task requires planning the implementation steps of a task that requires writing code. **For research tasks… do NOT use this tool**"; ensure plan is "clear and unambiguous; if there are multiple valid approaches or unclear requirements" keep planning. On exit the agent **reads the plan file from disk** and works off it — "the path towards spec always goes via the file system."
- Ronacher's counterpoint: pi (Mario Zechner) has no plan mode and Amp removed theirs; his own workflow = iterate on a markdown handoff file with clarifying questions. Design lesson: **mode-switching UI competes with just talking to the model — plan mode's real value is the reviewable artifact + the approval UX, not the mode per se.**

### 2.3 Replit — decision-time guidance (the adaptive-control reference) 

`p27-replit-decisiontime.txt` (Aug 2026, Replit engineering):
- "A lightweight **multi-label classifier** analyzes the agent's current trajectory — user messages, recent tool results, error patterns — and decides which guidance, if any, to inject. The classifier runs on a **fast, cheap model**, so it can fire on **every agent iteration** without becoming a bottleneck."
- Moves control from a monolithic system prompt to "a bank of reusable **micro-instructions**"; scales 4–5 static reminders → hundreds.
- **Pattern 1 — Diagnostic signals:** on repeated console errors, inject a *notification, not a context dump*: "Found 1 new browser console log, use the log tool to view the latest logs." Agent pulls details itself if it chooses.
- **Pattern 2 — Consult when it matters:** classifier detects **doom loops** (repeated failed attempts, circular edits, high-risk changes) → reminder to consult an **external agent that plans from fresh context** ("unburdened by failed attempts polluting the main agent's trace"). Exploits the **generator–discriminator gap**: the stuck agent need only *recognize* a good plan, not generate one. Consultation uses a **different model** to break self-preference bias.
- Principles: **false positives are cheap** (guidance is ignorable suggestions → tune for recall over precision); **guidance is ephemeral** (not persisted into history); **core prompt never changes** (prompt cache intact — "90% cost reduction vs dynamic system prompt modification").
- Also: Plan vs Build mode (`p13`): Plan = brainstorm/questions/read-only; generates task list; "Start building" auto-switches; Build = default; **checkpoint per completed task**.

### 2.4 Bolt / Lovable / Copilot / v0 — plan-then-execute UX details

- **Bolt** (`p09-bolt-plan`): Plan Mode = chat mode with full project context, web research, no code changes; "explore ideas safely, **save tokens by avoiding unnecessary code exchanges**, ensure you get things right before moving into Build Mode." **Quick action buttons** after each answer: "Implement this plan" (auto-switches to Build Mode), "Show an example", "Refine this idea" — contextual, varied by topic. Toggle in bottom-right of chatbox; blue when active; can start a project in Plan Mode from the homepage.
- **Lovable** (`p18-lovable-agentmode`): "Plan mode is for decision-making. Build mode is for execution." Build (previously Agent mode) is **default**; execution visibility = live task cards (current step, files, tools) + Details view (Timeline of every step incl. tool calls + Changes tab). Follow-ups mid-build steer "at its next natural stopping point without losing completed work"; deprecated message queue replaced by follow-ups + "Send now." **Verification tools (browser testing, frontend tests, edge function verification) run only when you ask for them** — "most of these tools run only when you ask." 10-hour per-message limit with wrap-up behavior in the final half-hour; credit check-ins pause long runs; usage-based pricing (files modified, complexity, exploration, tool usage).
- **GitHub Copilot** (`p17-copilot-modes`, `p32-copilot-cloudagent`): IDE trio — ask (answers, no changes) / edit (inline multi-file edits, **diff shown before saving** — "Copilot does the work, but you get the final say") / agent ("just goes ahead and does what it thinks you are asking… applies edits automatically rather than waiting for explicit approval, while still surfacing potentially risky commands for review"). Cloud agent: research → plan → changes on a branch → **iterate before creating a PR**; own ephemeral GitHub-Actions environment; assign issues; every step in commits/logs "adds transparency."
- **v0** (`p20-v0-planbuild`): community demanded Plan/Build modes for a year ("prevents it from getting ahead of itself, making unintended changes based on something that was more of a discussion than a direct command"); Vercel shipped **Plan Mode as a custom-instruction preset** (Oct 2025) — a prompt persona, not a tool-restricted mode. Plus prior research: `EnterPlanMode` tool in the leaked v0 prompt + `GenerateDesignInspiration` mandatory brief.

### 2.5 Amp — The Dial (the anti-mode counter-design) 

`p29-amp-dial.txt` (Jul 2026): Amp **deleted its modes** (smart/deep/rush/large — including the plan mode) and replaced them with one 4-position dial mapping to **model + reasoning effort + system prompt**:
- low ("you know exactly what you want") / medium (default; "strong enough for most work, fast enough to steer") / high ("about twice the wait," diffs "closer to reviewer-ready," plan on one round of feedback) / ultra (path full of unknowns).
- **Every tier has an oracle** — a second model for second opinions: "in high, GPT-5.6 Sol writes and Fable reviews. In ultra, Fable writes and GPT-5.6 Sol reviews."
- Deprecated modes return as installable plugins ("exact system prompts, exact tool lists") — plugin API registers custom agent modes.
- Guidance: "**Start at medium. Turn it down when the task is clear. Turn it up when a miss costs more than the wait.**"

---

## Part 3 — When to run self-review / verification

### 3.1 Theory: what the evidence supports

- **Verification is computationally easier than generation** (evjang, `p21`): "training a solution verifier… is computationally easier than training a solution generator." Practical form: "if you do not have the compute to 'just ask' for a solution, perhaps you can settle for 'just asking' for verification." BUT models differ wildly in critique ability: GPT-4 catches its own errors when re-asked ("does the solution meet the assignment?"); **GPT-3.5 and early Claude confidently approved their own wrong outputs** (non-rhyming poems that rhymed). → Critique quality is model-gated; a weak model rubber-stamping itself is worse than no critique.
- **Intrinsic self-correction without external signal often fails** (Huang et al., ICLR 2024, `s19-selfcorrect-limits`): "Large Language Models Cannot Self-Correct Reasoning Yet" — LLMs' self-correction of reasoning *without external feedback* can degrade performance; self-correction reliably helps when feedback comes from an **external oracle/ground truth** (tests, linters, tools, a different model, a rendered screenshot).
- **Reflexion** (Shinn et al. 2023, `p24`, `s16`): Actor + Evaluator + Self-Reflection with persistent memory; big gains on AlfWorld/HumanEval **across repeated episodes** — i.e., reflection pays when feedback is stored and reused, not just re-emitted. Limits the guide names: "Relies on the agent's ability to accurately evaluate its performance… challenging for complex tasks"; sliding-window memory; TDD-style checks can't express everything.
- **Self-Refine** (`s20-selfrefine`): iterative self-feedback improves outputs where the model's *feedback* is more reliable than its *generation* (style, length, formatting, tests-passing) — not universally.
- **Generator–discriminator gap + self-preference bias** (Replit, `p27`): a *fresh-context*, *different-model* reviewer recognizes good plans better than the stuck generator can produce them; same-model self-review favors its own outputs (cites "LLM Evaluators Recognize and Favor Their Own Generations").

**Net:** always-on same-context self-critique is the weakest form; external/orthogonal signal (rendered screenshot, deterministic validators, a different model, fresh context) is what makes critique worth its tokens.

### 3.2 The four production trigger patterns (Claude Code verification loops)

`p22-cc-verify-skills.txt` (Anthropic, Jul 2026) — how verification is actually scheduled in practice:

| Pattern | Mechanism | When it's right | Cost profile |
|---|---|---|---|
| **Standalone** | User invokes deliberately (`/verify`, `/code-review`, `/design`) after artifact exists | Cross-cutting checks that *don't apply every time*: pre-commit security scan, a11y audit, license headers | Each invocation is "a turn you have to remember" |
| **Embedded** | Fires automatically **as part of the producing skill** (e.g., scaffold-component skill ends with "run eslint on it and address any errors before reporting completion") | Check belongs to exactly one workflow | Zero marginal user effort; runs every time |
| **Chained** | One skill invokes another at its end (`/code-review → /simplify → /verify → /design`) — "What started as a habit becomes a contract" | Multi-step dev cycle; adding verification to skills you can't edit | **"Chained verification loops can increase token spend, so it's best to test these loops before deploying them broadly"** |
| **On every PR** | Team infrastructure; gates on push/PR | Hardening after the loop is stable; "hold off on PR-wide gates while the chain is still in flux" | Amortized across team |

Graduation rule: "The signal that you've outgrown standalone is when you're running it after every change. At that point, the procedure has earned a permanent home: embed it or chain it." Built-ins: `/verify` skill; toolchain error codes (list exact build/test commands in CLAUDE.md); **Code Review (managed multi-agent review pass)**; spec-validation skill (check changes against a markdown spec); **Rubrics in Claude Managed Agents: separate grader agent verifies outcomes against a rubric; failures loop back for rework automatically**.

### 3.3 Per-phase gates vs end-of-run verification (strongest single case study)

`p23-julio-verify.txt` (Jul 2026): 775-line spec, ~90 files, 5 phases. Claude's plan put **all verification in Phase E** ("build, build, build, build, verify") because the spec did. Consequences: "when it finally checks, it finds a pile of mistakes from the early phases that it now has to go back and fix. Sometimes it won't even notice until I push it to explain unexpected behaviors."
Fix — **rejected the plan in plan mode** with: *"Add concrete verification steps for each phase, which all must pass before starting next phase. Before moving to next phase you must also go over all decisions made on previous phases to see if any of them need a follow up in next phase."* Resulting plan adds per-phase:
- **Gate** = command + required result ("every check is something the computer can answer, not something Claude has to eyeball"); a red gate gets fixed inside its phase; **the next phase never starts on a broken one**.
- **Carry-forward review** = re-read every prior decision before the next phase; write down what creates work ahead.
- **Predictions/fallbacks** written down per phase (a predicted namespace collision "hit" two phases later and the agent used its pre-written fallback without getting stuck).
Outcome: 1 hour unattended, 209 integration + 20 Playwright tests green, 0 warnings, migration verified against a copy of the real DB. Author's conclusion: "the real fix is in the spec" — every phase gets **exit criteria**.

### 3.4 Adaptive (complexity/error-gated) verification — production patterns

- **Replit decision-time guidance** (§2.3): cheap classifier on every iteration → inject micro-guidance only when trajectory signals warrant (repeated console errors → "look at logs" nudge; doom-loop → fresh-context different-model consult). Recall-over-precision; ephemeral; cache-stable. **This is the canonical "adaptive, not always-on" reference.**
- **Claude Code auto mode**: *classifier-gated permission*, not verification — but the same shape: a cheap safety classifier wraps every action so the human doesn't review everything manually.
- **Cursor Agent Review**: default manual (`/agent-review` on demand or via Source Control tab); optional automatic-after-every-task; **Quick vs Deep cost tiers** chosen per invocation.
- **Lovable**: verification tools exist but "most of these tools run only when you ask for them" — user-triggered to control credit spend; agent still self-observes build errors/console output as deterministic signals.
- **v0**: verification = runtime feedback loop (console.log debug log read-back, skip stale errors by timestamp) + the **mandatory pre-generation design brief** (GenerateDesignInspiration — critique moved *before* generation as inspiration, not after as review).
- **Devin** (`p33-devin-autofix`): writer + reviewer agent pair — "One agent writes, the other pressure-tests, and this continues in a loop"; reviewer has "dedicated reasoning on the diff after it's written, and can go deep into specific issues not obvious just from the original plan"; autofix bot-triggers resolve the *mechanical* class (lint, null checks, off-by-one) automatically; "the human's job narrows to the decisions that require judgment."
- **Amp**: oracle review bundled into effort tiers — review happens at high/ultra by construction ("a miss costs more than the wait").

### 3.5 Synthesis — when per-turn self-review helps vs wastes tokens

**Helps (evidence-backed):**
1. Verification with **external/orthogonal signal** (rendered screenshot, deterministic validators/linters, tests, cross-model review, fresh-context review) — Huang et al.; evjang; Claude Code rubrics; AgentCanvas's own stress test (VLM-on-real-screenshot fixed dark-mode 2/10→9/10).
2. **Per-phase gates on multi-step work** — machine-checkable exit criteria per phase beat one big end-of-run pass (Julio).
3. **Error-triggered review** — repeated failures/console errors are the highest-precision trigger (Replit; Claude Code toolchain).
4. **Doom-loop rescue via different model + fresh context** — recognition beats generation (Replit).
5. **User-triggered deep review with cost tiers** (Cursor Quick/Deep; Claude Code standalone skills; Lovable on-request tools) — user knows when a miss is expensive.
6. **Pre-generation critique-as-inspiration** (v0 brief) — cheaper than post-hoc review because it prevents defects instead of finding them.

**Wastes tokens / actively hurts:**
1. **Same-model, same-context self-critique every turn** — rubber-stamping bias (self-preference), no new information; AgentCanvas audit S3 documented quadruple redundancy (+5–6 sub-agent LLM calls/turn even on clean output).
2. **Self-correction of reasoning without external feedback** — can *degrade* accuracy (Huang et al.).
3. **End-of-run-only review on big multi-phase tasks** — late, expensive rework (Julio's Phase E).
4. **Always-on chains on trivial turns** — Claude Code's own warning: chained loops "can increase token spend… test before deploying broadly."
5. **Critique on weak models** — GPT-3.5-class critics approve their own failures (evjang).

---

## Part 4 — Design recommendations for AgentCanvas

Concrete proposals, mapped to evidence. (AgentCanvas context: single agent panel + infinite canvas; existing classifier/turn categories; brief pre-generation; critique loop w/ text+VLM critics; variant-generator subagent; todo plugin; snapshot per turn; current stress-test pain points: 2.5–13.5 min/turn, critique can't revert degrading iterations, no clarification on vague prompts, final message fragmented.)

### 4.1 Mode set: 4 modes, one composer

| Mode (name) | Trigger / when | Tool surface (enforced at tool-execution layer) | Writes to canvas? |
|---|---|---|---|
| **Design** (default; "the doer") | Everyday generation/edits | Full pen_* + figma_* + plugins + subagents + critique | Yes |
| **Ask** (read-only) | Understanding the doc: "what's on this canvas?", "why is this text clipped?", audits | Read-only set: `pen_get_metadata`, `pen_read_node`, `pen_list_*`, `pen_search_*`, screenshot, design-system queries. **All mutating tools physically excluded from the tool list** (not prompt-banned) | No |
| **Plan** | New multi-screen flows, vague/conflicting briefs, "redesign", big refactors | Read-only set + `goal_interview`/ask-user + **plan-file tool** (write plan doc only) | No (plan doc only) |
| **Draft/Explore** (cheap) | "give me 3 directions", style exploration, throwaway variants | Variant-generator subagent path only; low call budget (≤6), no DS writes, variants go to a scratch region/overlay | Scratch region only |

Naming note: avoid "Agent" (means everything and nothing in 2026); Cursor's Debug/Design split suggests naming by *intent*. A future **Debug** mode ("this screen renders wrong, find out why") can reuse the Plan skeleton with a diagnose-first phase — defer.

**Amp counter-pattern respected:** modes are complements, not tiers — do NOT add model/effort tiers to the mode picker. Model choice stays a separate dropdown. If cost-steering is wanted later, adopt a **Dial-style effort control** (low/medium/high) that also raises critique depth (see 4.4), not more modes.

### 4.2 Mode selection UX

1. **Mode pill in the composer** (left of send button): icon + name; click = dropdown with the 4 modes + "Custom…" (skills). Keep **model picker separate** (Cursor lesson).
2. **Shift+Tab cycles modes** when composer is focused (Ask → Design → Plan → Design...); **slash commands** `/plan`, `/ask`, `/design`, `/draft` also switch (typed prefix works mid-composition; CLI parity).
3. **Auto-suggest Plan, never auto-switch** (Cursor pattern): when the intent classifier (already exists!) detects complex/vague/multi-screen prompts, surface a one-click chip above the composer: *"This looks like a multi-screen build — Plan first?"* [Plan] [Just build]. Do NOT flip the user's mode for them (Cursor forum chaos thread is the cautionary tale).
4. **Mode = tool surface, shown honestly**: when in Ask/Plan, the tool-count indicator (already surfaced post-audit) should visibly shrink — users learn what a mode means from the affordance, not docs.
5. **Each mode keeps its own context** (Cursor): mode switch mid-chat = context fork warning chip ("Plan started a fresh thread — Ask history is one click away"). Simplest v1: mode switch starts a new turn thread but shares the canvas snapshot.
6. **Custom modes from skills** (Cursor Custom Modes): any skill in `skills/` with frontmatter `mode: true` + optional `icon`/`color` can be pinned as a persistent mode badge (e.g., a `/brand-guardrails` skill staying active for a whole session). This replaces the dead "custom modes" idea cheaply since skills infra exists.

### 4.3 Plan mode → approval flow (the contract)

1. Plan turns are **read-only enforced**: mutating tools are removed from the tool list server-side (tool-registry filter by mode — same mechanism as the existing category filtering, so it's honest enforcement, not prompt-only. Claude Code/Cursor bug reports prove prompt-only fails).
2. Flow: clarifying questions (via existing `goal_interview`, now non-blocking like Cursor's ask-questions tool — **agent keeps researching the canvas while waiting**) → plan written to a **plan document** rendered as an editable card in chat (markdown; Canvas-native: also a plan node pinned near the work).
3. **Approval triad (Claude Code pattern, adapted):**
   - **"Build it"** → switch to Design mode, execute plan (plan doc referenced as source of truth; each step mapped to plan sections).
   - **"Build, and auto-fix"** → Design mode + critique loop set to auto-apply fixes (see 4.4).
   - **"Keep planning"** (reject with feedback) → stays in Plan; feedback becomes a plan revision.
   Plus **inline editing of the plan card** (Claude Code Ctrl+G equivalent: click any plan bullet to edit text; Bolt's "Refine this idea" quick-action button on the card).
4. **Plan = named artifact**: plans save to the doc (like Cursor "Save to workspace"); accepting a plan titles the chat turn (Claude Code); the plan node stays on canvas for reference and future turns can @mention it.
5. **"Starting over from a plan" affordance** (Cursor docs' own advice): when a build disappoints, the UI should offer *Revert to pre-build snapshot + refine plan + rebuild* as a first-class action — this directly fixes the stress-test finding "critique loop can't revert degrading iterations."
6. **Per-phase gates for multi-screen plans** (Julio): plans with ≥3 screens get phases with **machine-checkable exit criteria** (node counts, no zero-extent nodes, all text non-placeholder, contrast lint pass) — gate red = fix within phase before the next screen starts; carry-forward review between phases (re-read decisions, note follow-ups + predicted risks with fallbacks).
7. **ExitPlanMode-equivalent tool discipline**: agent may call `submit_plan` only when the plan is complete and unambiguous; research questions in Plan mode return answers, not plans (Claude Code's tool description is the model — copy its phrasing).

### 4.4 Adaptive critique gating (replace always-on critique)

Current pain: mandatory text+VLM critique every design turn (audit S3: +5–6 LLM calls/turn; stress test: turns 2.5–13.5 min). Replace with a **gated ladder** (all evidence in Part 3):

**Gate 0 — deterministic lint (always on, zero LLM cost):** run the existing validators as a post-patch pass every turn — zero-extent nodes, orphan parentId, placeholder text, off-grid values, contrast (WCAG on fill/text pairs), DS-token drift. Auto-fix mechanical violations, report what was fixed (v0-style). *This is Devin's "mechanical class gets caught automatically."*

**Gate 1 — VLM critique, complexity-gated (runs when ANY):**
- turn creates ≥N nodes (suggest N=20) or ≥2 screens;
- classifier category = 'multi' or new-document creation;
- Gate 0 found ≥3 violations;
- user explicitly asks ("make it beautiful", "polish", /critique).
Skip on: small edit turns (recolor, retext, move), Ask mode, Draft mode, turns where prior score ≥8/10 and diff is small. *Evidence: Claude Code embedded-vs-standalone; Lovable on-request; Cursor Quick/Deep tiers; audit S3 waste.*

**Gate 2 — doom-loop rescue (Replit pattern):** cheap watchdog watches the run's signal (existing WATCHDOG_MS infra): ≥2 consecutive failed fix-turns, repeated identical tool errors, patch churn on same node ≥3× → **pause, spawn fresh-context reviewer with a different model** (kimi vs fallback endpoint), get a plan to escape, show user a "Agent seems stuck — external review suggests: …" card with [Apply] [Stop]. *Evidence: generator–discriminator gap + self-preference bias.*

**Gate 3 — user-triggered deep review:** `/critique` command + "Review" button on any turn/result → full rubric VLM critique on the real client screenshot (already wired post-audit), with **Quick vs Deep** choice (Cursor Agent Review tiers): Quick = 1 pass, top-3 issues; Deep = rubric grid + per-screen passes + ranked fix list executed as a fix-turn.

**Rules of engagement (from Replit/Claude Code):**
- Critique *prompts* are ephemeral micro-injections (decision-time guidance) — never appended to the system prompt (keeps the byte-stable cacheable prefix from audit P4 intact).
- Tune gates for recall over precision — a redundant critique is cheap; a missed disaster isn't (Replit: "false positives are cheap").
- Critic sees ONLY the rendered screenshot + rubric (never the tool stream) — already the post-audit architecture; keep it (evjang: orthogonal signal).
- Cross-model where possible (Amp oracle; Replit consult): VLM critic on a different endpoint than the generator.
- Critique output must be **actionable + revertible**: fixes apply as patches to a checkpoint, with one-click "revert this critique round" (fixes stress-test finding).
- Show cost intent: like Cursor's context ring, surface "this turn: N LLM calls / ~X tokens" per turn card so users see what gating saved.

### 4.5 Parallel-run model (canvas-native)

1. **Threads, not tabs** (Cursor side chats + Figma parallel prompts + MagicPath): one main agent thread per document; **"+ thread" button** in the agent panel or **Shift+click a canvas region** → new thread scoped to that region/selection; thread inherits doc snapshot + current selection at spawn. Each thread = full agent session with its own mode. Findings merge via **@thread-mentions** in the main composer.
2. **On-canvas progress indicators** (Figma agent, prior research + confirmed): each running thread shows an animated chip at its region ("Building checkout… 6/12") — click to open its transcript. This is the single most-copied pattern across Figma/MagicPath/Cursor Design Mode.
3. **Selection-anchored prompts** (Cursor Design Mode + Figma): click node → Cmd/Ctrl+Enter opens composer pre-anchored to selection (@-mention inserted); **draw-a-box annotation** on canvas = spatial scope for a prompt (Cursor Design Mode's frozen-frame annotation — AgentCanvas already has measure-overlay infra to build on). What the agent receives: node identity (id + semantic path + resolved styles) **plus screenshot crop** — Cursor's dual-signal ("element identity + screenshot… complementary signals").
4. **Parallel decomposition with explicit isolation**: `/multitask`-style command for "build these 5 screens" → agent proposes per-screen subtasks (like Cursor "break larger tasks into smaller chunks"), each executed as a thread pinned to a screen-sized region. Isolation = **region-scoped patch filter**: a thread's mutating tools reject nodeIds outside its region unless the plan says otherwise. (Cursor v0-multitask's admitted collision problem is why region-scoping matters more here than in code, where worktrees exist.)
5. **Best-of-N for style directions** (Cursor `/best-of-n` + existing variant-generator): "3 style directions" runs variant-generator siblings, each in its own region, judged (existing judge), winner promoted with the others kept grayed as "alternatives" (Figma go-wide framing — prior research rec #8).
6. **Queue + steer** (Cursor): while a thread runs, Enter = queue for after; Cmd+Enter = steer at next tool call (both already partially exist as steer/abort — extend with queue UX and reorder).
7. **Worktree analog = branch document**: defer, but note the pattern (Framer branching, Cursor worktrees): "try this direction without touching my layout" → fork the doc, run agent, compare side-by-side, merge or discard.

### 4.6 Mode/tool matrix (enforcement reference)

| Capability | Ask | Plan | Draft | Design |
|---|---|---|---|---|
| Read canvas (metadata/read_node/search/screenshot) | ✅ | ✅ | ✅ | ✅ |
| Design-system/theme reads | ✅ | ✅ | ✅ | ✅ |
| goal_interview / ask user | ✅ (primary) | ✅ | ➖ | ✅ |
| Plan document write | ❌ | ✅ (only this write) | ❌ | ✅ (via plan step) |
| pen_* mutating tools | ❌ | ❌ | scratch-region only | ✅ |
| Component/theme library writes | ❌ | ❌ | ❌ | ✅ |
| Variant generation | ❌ | ❌ | ✅ | ✅ |
| Web research subagent | ✅ | ✅ | ➖ | ✅ |
| Critique (text/VLM) | ❌ (read-only opinions are just answers) | ❌ | judge only (no fix-turns) | ✅ gated per 4.4 |
| Export/commit | ❌ | ❌ | ❌ | ✅ |

Enforcement point: extend the existing category→toolset filtering (post-audit T3) with a **mode filter at tool-registry assembly** (same code path), so Ask/Plan literally cannot see mutating tools — the audit's alias-bypass lesson + the Cursor forum chaos thread both argue for structural, not advisory, enforcement.

### 4.7 Token/cost implications per mode (for budgets & pricing UX)

- **Ask**: read-only tools only; cap canvas snapshot to digest (already 300 lines); no critique calls; expected ~1/3 the tokens of a Design turn.
- **Plan**: research reads + 1 plan-write; NO patch fan-out, no critique — communicate "Plan Mode saves tokens by avoiding generation round-trips" (Bolt's exact rationale) in the mode tooltip.
- **Draft**: hard budget ≤6 tool calls + 1 judge call; variants in scratch region (cheap doc footprint).
- **Design**: current budgets (≤12 calls); critique per Gate 1 only.
- Surface per-turn cost on the turn card (calls + est. tokens); show "skipped critique (small edit) — saved ~X" when a gate skips (reinforces the system's intelligence; Cursor context-ring precedent).

### 4.8 Priority order (impact × effort for AgentCanvas)

1. **Mode pill + Ask/Design split with tool-registry enforcement** (small — extends T3 filtering; big safety + clarity win; fixes "off-topic prompt builds junk" stress case by making Ask the safe default for non-design asks).
2. **Adaptive critique gating ladder** (moderate — mostly deleting always-on calls + wiring gate conditions to signals that already exist: node counts, validator results, watchdog).
3. **Plan mode + approval triad + per-phase gates for ≥3-screen plans** (moderate; plan doc = new artifact type; reuses goal_interview + todo plugin cards).
4. **Threads + on-canvas progress chips + region-scoped /multitask** (largest; the differentiating canvas-native feature vs every chat product above).
5. Selection-anchored prompting + annotation-box scope (Cursor Design Mode parity).
6. /critique Quick/Deep + revert-critique-round (small on top of #2).
7. Auto-suggest-Plan chip on complex prompts (tiny; classifier exists).
8. Custom modes from skills frontmatter (small; skills registry exists).

---

## Appendix — raw evidence files

Searches: `raw/s01-cursor-modes` … `raw/s27-copilot-agent` (27 files).
Pages: `raw/p01-cursor-plan-mode` (Cursor docs Plan Mode), `p02` agent overview, `p04` Cloud Agents, `p05` planning, `p06` cursorforpms modes-explained (Aug 2026), `p07` Claude Code permission-modes, `p08` Ronacher plan-mode teardown, `p09` Bolt Plan Mode, `p11` Agents Window, `p12` forum plan-mode violation, `p13` Replit Plan-vs-Build, `p14` cursor llms.txt, `p15-*` debug/design/agent-review/prompting (.md), `p16-*` cli-using/slash-commands/canvas/worktrees/skills (.md), `p17` Copilot modes blog, `p18` Lovable Build mode, `p19` Windsurf/Devin Cascade modes, `p20` v0 plan/build thread, `p21` evjang self-critique, `p22` Claude Code verification loops, `p23` Julio Casal per-phase gates, `p24` Reflexion guide, `p25` DataCamp Cursor 3, `p26` Cursor 3.11 side chats, `p27` Replit decision-time guidance, `p28` Cursor 3.0 changelog, `p29` Amp The Dial, `p30` MagicPath 2.0, `p31` /multitask forum, `p32` Copilot cloud agent docs, `p33` Devin autofix.
