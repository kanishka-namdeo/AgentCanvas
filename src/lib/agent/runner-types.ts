// Shared runner types — extracted to break circular imports.
//
// `runner.ts` defines `runAgent`, `AgentRunOptions`, `LLMClient`, and
// `AgentStreamEvent`. Other modules (translator, subagents) need
// `AgentStreamEvent` and `LLMClient` for typing — but importing them
// directly from `runner.ts` creates a circular dependency:
//
//   runner.ts → translator.ts → runner.ts  (cycle)
//
// To break the cycle, the type-only exports live here. The implementation
// (the `runAgent` function itself) stays in `runner.ts` and re-exports
// these types for backward compatibility.

import type { CanvasPatch, SyncEvent } from '../canvas/types';

/// One event in the agent event stream. The runner is an
/// `async function*` that yields these.
///
///   - `patch`: a canvas mutation. The caller forwards these to the
///     canvas store + the Socket.IO broadcast service so all viewers
///     see the change in real time.
///   - `agent_event`: a sync event for the UI / chat stream. Covers
///     message deltas, tool-call lifecycle, plan updates, sub-agent
///     dispatch, etc. (See `SyncEvent` in `../canvas/types.ts` for the
///     full vocabulary.)
export type AgentStreamEvent =
  | { kind: 'patch'; patch: CanvasPatch; toolCallId?: string }
  | { kind: 'agent_event'; event: SyncEvent };

/// Minimal LLM client interface the runner needs. Mirrors the OpenAI
/// tool-calling protocol shape that `z-ai-web-dev-sdk` exposes, so the
/// real ZAI client satisfies this interface without adaptation.
///
/// Tests pass a `MockLLM` that returns scripted completions per iteration.
export interface LLMClient {
  chat: {
    completions: {
      create: (params: {
        messages: Array<{
          role: 'system' | 'user' | 'assistant' | 'tool';
          content: string;
          tool_calls?: any[];
          tool_call_id?: string;
        }>;
        tools?: any[];
        tool_choice?: string | any;
        temperature?: number;
      }) => Promise<{
        choices: Array<{
          message: {
            content?: string | null;
            tool_calls?: Array<{
              id: string;
              type: 'function';
              function: { name: string; arguments: string };
            }>;
          };
        }>;
      }>;
    };
  };
}

export interface AgentRunOptions {
  documentId: string;
  prompt: string;
  /// Snapshot of the canvas at the start of the turn.
  canvas: CanvasDocument;
  /// Optional LLM client override. Defaults to `z-ai-web-dev-sdk` (ZAI).
  /// Used by tests to inject a deterministic mock; in production this is
  /// always undefined and the runner constructs the ZAI client itself.
  llm?: LLMClient;
  /// Optional abort signal.
  signal?: AbortSignal;
  /// User-tunable run settings (temperature, maxIterations, planFirst,
  /// defaultPalette, skillSelectionMode, LLM provider config). When omitted,
  /// the runner uses the previous hard-coded defaults (0.4 / 20 / true / 'slate'
  /// / 'auto' / zai-auto). This keeps the existing test suite (which doesn't
  /// pass settings) working without modification.
  settings?: AgentRunSettings;
  /// Image attachments staged by the user in the chat input (paste, drop,
  /// or the paperclip). Passed to the pi SDK's session.prompt({ images })
  /// so vision-capable models see them natively. Entries are compact data
  /// URLs — see lib/agent/attachments.ts for the client-side pipeline.
  images?: Array<{ id?: string; name?: string; dataUrl: string }>;
}

// Type-only re-exports to avoid runtime circular imports. These are imported
// with `import type` so they don't pull the runtime module graph.
import type { CanvasDocument } from '../canvas/types';
import type { AgentRunSettings } from '../settings/types';
