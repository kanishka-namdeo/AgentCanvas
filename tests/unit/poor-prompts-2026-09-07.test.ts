// poor-prompts-2026-09-07.test.ts — Poor-prompt hardening invariants.
//
// Context: a 10-scenario real-world poor-prompt battery (empty /
// gibberish / emoji / anaphora-on-empty / typo-storm / non-English /
// run-on multi-intent / off-scope / mega-long / vague follow-up —
// scripts/agent-eval/poor-prompts.ts) found the app 9/10 robust. The one
// failure: "make it blue and bigger" on an EMPTY canvas — the model
// reasoned "nothing to modify" then hallucinated 8 shapes (193s). Also
// latent: a non-string `prompt` crashed the route's `.trim()` → 500, and
// there was no prompt length cap before the ~24k-token gateway limit.
//
// This file pins the three hardening layers:
//   1. prompt-intent.ts — looksLikeEditReference() behavior (pure unit).
//   2. runner-native.ts — the guard wiring invariants (source scan, same
//      pattern as endpoint-presets / followup-delta tests).
//   3. route.ts — type-safe extraction + the 20k-char cap (source scan).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { looksLikeEditReference } from '@/lib/agent/prompt-intent';

// ---------------------------------------------------------------- 1. predicate

describe('looksLikeEditReference — anaphora detection', () => {
  it.each([
    ['make it blue and bigger', 'verb + bare pronoun (the battery failure)'],
    ['make it pop', 'evaluative anaphora'],
    ['make this bigger', 'pronoun + comparative'],
    ['change the color to red', 'definite canvas-relative reference'],
    ['update them', 'verb + pronoun'],
    ['Make It Blue', 'case-insensitive'],
    ['  fix it  ', 'whitespace tolerated'],
    ['make those darker', 'demonstrative plural + comparative'],
    ['set the background to dark', 'definite reference (background)'],
    ['make everything smaller', 'everything pronoun'],
  ])('TRUE for %j (%s)', (prompt: string) => {
    expect(looksLikeEditReference(prompt)).toBe(true);
  });

  it.each([
    ['make me a login page', 'concrete artifact: login page'],
    ['make this landing page dark', 'concrete artifact swallows the pronoun'],
    ['create a dashboard with 3 charts', 'creation verb + artifact'],
    ['build a pricing page', 'creation'],
    ['design a login screen', 'creation'],
    ['what makes a good login screen?', 'question — no edit verb + pronoun pair'],
    ['add a settings screen with a toggle', 'artifact: settings screen'],
    ['generate a navbar', 'artifact: navbar'],
    ['', 'empty'],
    ['   ', 'whitespace only'],
  ])('FALSE for %j (%s)', (prompt: string) => {
    expect(looksLikeEditReference(prompt)).toBe(false);
  });
});

// ------------------------------------------------------- 2. runner wiring scan

const runnerSrc = readFileSync(
  join(process.cwd(), 'src/lib/agent/runner-native.ts'),
  'utf8',
);

describe('runner-native — empty-canvas edit guard wiring (source invariants)', () => {
  it('computes clarifyOnEmptyCanvas gated on build mode + empty canvas + edit-reference prompt', () => {
    expect(runnerSrc).toContain('const clarifyOnEmptyCanvas =');
    expect(runnerSrc).toMatch(
      /clarifyOnEmptyCanvas =\s*mode === 'build' &&\s*turnStartShapeIds\.size === 0 &&\s*looksLikeEditReference\(prompt\);/,
    );
    expect(runnerSrc).toMatch(/import \{ looksLikeEditReference \} from '\.\/prompt-intent';/);
  });

  it('brief pre-generation stands down on clarify turns (the hallucination accomplice)', () => {
    // Speed-parity P0.5: predicate narrowed from isDesignRequest → isMultiSectionDesignRequest.
    // Trivial prompts ("draw a red rectangle") skip the brief race entirely.
    expect(runnerSrc).toMatch(
      /shouldEnforceBrief = isMultiSectionDesignRequest\(prompt\) && mode === 'build'\s*&& turnStartShapeIds\.size === 0\s*&& !clarifyOnEmptyCanvas;/,
    );
  });

  it('text-only design-turn guards stand down on clarify turns (clarification is the correct output)', () => {
    expect(runnerSrc).toMatch(
      /expectsCanvasOutput = mode === 'build' && isDesignRequest\(prompt\) && !QUESTIONISH_PROMPT && !clarifyOnEmptyCanvas;/,
    );
  });

  it('the EMPTY-CANVAS EDIT GUARD block is injected into the first user message', () => {
    expect(runnerSrc).toContain('[EMPTY-CANVAS EDIT GUARD:');
    expect(runnerSrc).toContain('clarifyGuardSection');
    // binds to the prompt in BOTH user-message arms (web-research + plain)
    expect(runnerSrc).toMatch(
      /\$\{selectionNote\}\$\{prompt\}\$\{clarifyGuardSection\}/,
    );
  });
});

// ---------------------------------------------------------- 3. route hardening

const routeSrc = readFileSync(
  join(process.cwd(), 'src/app/api/agent/route.ts'),
  'utf8',
);

describe('/api/agent route — poor-prompt input hardening (source invariants)', () => {
  it('extracts prompt type-safely (non-string prompt must not crash .trim())', () => {
    expect(routeSrc).toMatch(
      /const prompt: string = typeof body\.prompt === 'string' \? body\.prompt : '';/
    );
    expect(routeSrc).toMatch(
      /typeof body\.documentId === 'string' && body\.documentId \? body\.documentId : 'default';/
    );
  });

  it('caps prompt length before any LLM call', () => {
    expect(routeSrc).toContain('MAX_PROMPT_CHARS = 20_000');
    // the cap check must come BEFORE the runAgent invocation
    const capIdx = routeSrc.indexOf('prompt.length > MAX_PROMPT_CHARS');
    const runIdx = routeSrc.indexOf('runAgent(');
    expect(capIdx).toBeGreaterThan(-1);
    expect(runIdx).toBeGreaterThan(capIdx);
  });

  it('still rejects empty/whitespace prompts with 400', () => {
    expect(routeSrc).toContain("if (!prompt.trim())");
    expect(routeSrc).toContain("error: 'prompt is required'");
  });
});
