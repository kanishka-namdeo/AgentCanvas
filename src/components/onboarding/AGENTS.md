# AGENTS.md — `src/components/onboarding/`

## Purpose

First-run onboarding UI: a 2-step modal (`welcome` → `templates`) shown once per browser when `useOnboarding.hasCompleted` is false. Step 1 sells the value prop with an animated CSS demo; step 2 is a curated starter-template picker that pre-fills the chat composer so the user can hit Enter to generate their first design.

## Ownership

- `OnboardingDialog.tsx` — the only file in this folder. `'use client'` component mounted in `src/app/app/page.tsx`, lazily via `next/dynamic` (deferred mount gated on `!hasCompleted`). Reads `hasCompleted` from `useOnboarding` (Zustand store in `src/lib/onboarding/store.ts`, persisted to `localStorage:agentcanvas.onboarding.v1`). Step 1 (`WelcomeStep`) is a welcome screen with a looping CSS animation (`AnimatedDemo`), three value-prop bullets, a "Skip tour" ghost button, and a "Pick a starter" brand-gradient CTA. Step 2 (`TemplateStep`) renders `ONBOARDING_TEMPLATES` (from `src/lib/onboarding/store.ts`) as tiered cards (Fast / Detailed badges). Selecting a template calls `complete(template.id)` then `onSelectTemplate(template.prompt)`, which fires the `agentcanvas:composer-prefill` CustomEvent consumed by `src/app/app/page.tsx`. Skipping calls `skip()`. The "Replay onboarding" ⌘K command (`view.onboarding`) calls `useOnboarding.getState().reset()` to re-trigger.

## Local Contracts

- Templates come from `ONBOARDING_TEMPLATES` in `src/lib/onboarding/store.ts` — do not inline them in the component; a single source lets the catalog evolve without touching the dialog.
- The dialog is `onPointerDownOutside={(e) => e.preventDefault()}` + `onEscapeKeyDown={(e) => e.preventDefault()}` — onboarding is not dismissable by click-away or Esc; the user must use the Skip or Pick-a-starter CTAs (this is intentional so the analytics event fires).
- Theme + tokens: the dialog uses `ac-surface-*`, `ac-brand-gradient`, `ac-border-subtle`, `ac-text-*` like every other chrome surface — no raw hex. The AnimatedDemo's accent + cursor colors use `var(--ac-accent)`.
- The composer-prefill protocol: `onSelectTemplate(prompt)` must be wired by the parent (page.tsx) to dispatch the `agentcanvas:composer-prefill` CustomEvent with `{ detail: { prompt } }`. The component itself does NOT touch the composer directly.

## Work Guidance

- When adding a new template: add it to `ONBOARDING_TEMPLATES` in `src/lib/onboarding/store.ts` (id, title, description, prompt, tier badge). The dialog renders from that array automatically.
- When changing step count: the internal `step` state (`'welcome' | 'templates'`) is the only routing primitive — adding a 3rd step means extending the union + the conditional render block + the "Skip" availability check per step.
- Keep the dialog SHORT — the design rationale (v0/Bolt/Lovable/Canva patterns) is to minimize friction to the first generation. Do not add a 3rd step without strong evidence.
- All analytics flow through the `emitAnalyticsEvent` stub in the store — wire a real SDK there, not in the component.

## Verification

- `bunx tsc --noEmit` — typecheck.
- `bun run lint` — ESLint.
- Manual: clear `localStorage:agentcanvas.onboarding.v1`, reload `/app` — the welcome step shows; click "Pick a starter" — the template step shows; click a template — the dialog closes and the composer pre-fills with the template's prompt; verify the `agentcanvas:composer-prefill` event payload (`event.detail.prompt`) matches.
- Manual: click "Skip tour" — the dialog closes, `hasCompleted=true`, `skipped=true`; verify the console emits `[onboarding-analytics] { type: 'onboarding_skipped' ... }`.
- Manual: ⌘K → "Replay onboarding" — `useOnboarding.getState().reset()` clears `hasCompleted`; reload — the dialog shows again.

## Mistakes & Lessons

### Failure Modes

- Check that `OnboardingDialog` is lazy-mounted via `next/dynamic` and gated on `!hasCompleted` BEFORE adding it to a new route — mounting eagerly adds bundle weight to every page load.
- Check that the `agentcanvas:composer-prefill` CustomEvent is dispatched by the parent (page.tsx), NOT by the component — the component should call `onSelectTemplate(prompt)` only; emitting the event from inside the component couples it to the composer implementation.
- Check that a new template's `prompt` field is a single self-contained string — multi-message prompts need a different mechanism (the prefill protocol assumes one composer string).
- Check that `hasCompleted` is the gating flag — do NOT add a parallel `seen` boolean; the store's `hasCompleted` is the single source.

### Lessons Learned

- Do not make the dialog dismissable by click-away or Esc — the analytics event (skip vs complete) must fire, so force the user through one of the two CTAs.
- Do not inline templates in the component — keep them in `ONBOARDING_TEMPLATES` in `src/lib/onboarding/store.ts` so the catalog can evolve without touching the dialog.
- Do not add steps lightly — the 2-step design (welcome + template picker) is the deliberate minimum; the real "aha" is the first generation, so minimize friction to get there.
- Do not couple the dialog to the composer — go through the `onSelectTemplate` prop + the `agentcanvas:composer-prefill` CustomEvent so the dialog stays reusable.

## Child DOX Index

No child AGENTS.md files in this folder.

*Siblings: `../canvas/AGENTS.md` (Canvas UI — owns the composer that consumes the prefill event), `../sessions/AGENTS.md` (Session UI), `../settings/AGENTS.md` (Settings dialog).*
