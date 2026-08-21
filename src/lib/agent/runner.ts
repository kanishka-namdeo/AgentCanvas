// Agent runner — public entry point.
//
// This file is a thin delegator. It exports `runAgent` (the function the
// HTTP route, the WebSocket service, and the tests all call) and routes
// the call to one of two implementations:
//
//   - `runAgentNative` (in `./runner-native.ts`): the new production path
//     using `createAgentSession` from `@earendil-works/pi-coding-agent` +
//     pi-ai for model resolution. This is the "full SDK swap" — the
//     hand-rolled LLM loop is gone, replaced by the native Pi Agent SDK.
//
//   - `runAgentLegacy` (in `./runner-legacy.ts`): the original hand-rolled
//     LLM loop. Used when the caller passes `injectedLlm` (the test suite
//     does this to inject a `MockLLM` that satisfies the OpenAI-shaped
//     `LLMClient` interface — pi-ai's `Model` interface can't be satisfied
//     by the mock).
//
// Type re-exports keep existing imports working:
//   `import { runAgent, type LLMClient, type AgentStreamEvent } from '@/lib/agent/runner'`
// still works without modification.

import type { AgentRunOptions, AgentStreamEvent, LLMClient } from './runner-types';
import { runAgentLegacy } from './runner-legacy';
import { runAgentNative } from './runner-native';

// Re-export the shared types for backward compatibility.
export type { LLMClient, AgentStreamEvent, AgentRunOptions } from './runner-types';
// Re-export the legacy runner's helpers + types for any code that imports
// them directly (e.g. tests, the API route, the WebSocket service).
export {
  runAgentLegacy,
  buildSubAgentLLMClient,
  buildSystemPrompt,
  buildPlanFirstSection,
  buildPalettesList,
  canvasSnapshot,
  normalizeCanvas,
  filterToolSpecs,
  SYSTEM_PROMPT_TEMPLATE,
} from './runner-legacy';
export type { AgentRunHandle } from './runner-legacy';

// ---- Public entry point ----------------------------------------------------

/// Run the agent. Routes to the native (pi-ai + createAgentSession) path
/// when no `injectedLlm` is supplied, or the legacy (hand-rolled loop) path
/// when one is. The native path is production; the legacy path is for tests.
export async function* runAgent(opts: AgentRunOptions): AsyncGenerator<AgentStreamEvent> {
  if (opts.llm) {
    // Test mode: a MockLLM was injected. Use the legacy loop, which
    // consumes the OpenAI-shaped `LLMClient` interface directly.
    yield* runAgentLegacy(opts);
    return;
  }
  // Production: use the native pi-ai + createAgentSession path.
  yield* runAgentNative(opts);
}
