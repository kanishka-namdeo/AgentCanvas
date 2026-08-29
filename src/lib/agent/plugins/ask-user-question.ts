// Plugin: ask-user-question
//
// Lets the agent ask the user structured clarifying questions mid-turn with
// typed options. Inspired by @juicesharp/rpiv-ask-user-question but
// re-implemented natively for the web (no TUI dependency).
//
// When the agent calls `ask_user_question`, the tool:
//   1. Generates a unique toolCallId (matching the SDK's tool execution).
//   2. Emits an `agent:ask_user_question` SyncEvent with the questions.
//   3. Blocks (awaits) until the user submits answers via the API.
//   4. Returns the answers as the tool result so the agent can continue.
//
// The frontend renders a dialog when it sees `agent:ask_user_question`,
// and POSTs the user's choices to `/api/agent/answers` which resolves the
// pending promise.

import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { emitEvent } from './event-bus';

// ---- Pending question tracking --------------------------------------------
//
// Map of toolCallId → { resolve, reject, timer }. When the user submits
// answers via /api/agent/answers, we look up the entry and resolve it.
// A 5-minute timeout prevents permanent hangs if the user closes the tab.

interface PendingQuestion {
  resolve: (answers: string[][]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingQuestions = new Map<string, PendingQuestion>();

const ASK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/// Called by the /api/agent/answers route when the user submits answers.
/// Resolves the pending tool call.
export function resolveAskUserQuestion(toolCallId: string, answers: string[][], cancelled: boolean): void {
  const p = pendingQuestions.get(toolCallId);
  if (!p) return; // Already timed out or never registered.
  clearTimeout(p.timer);
  pendingQuestions.delete(toolCallId);
  if (cancelled) {
    p.resolve([['__cancelled__']]);
  } else {
    p.resolve(answers);
  }
}

/// Get the list of currently-pending question toolCallIds (for the
/// /api/agent/pending route, which the frontend polls to see if there
/// are any pending questions on reconnect).
export function getPendingQuestions(): string[] {
  return Array.from(pendingQuestions.keys());
}

/// Audit 2-c S6: register a pending question WITHOUT owning the ask_user_question
/// tool — other plugins (goal_interview) reuse the same dialog + resolution
/// path (emit `agent:ask_user_question`, the frontend POSTs to
/// /api/agent/answers, resolveAskUserQuestion resolves). Previously
/// goal_interview never registered here, so its 100ms poll "resolved"
/// instantly and silently discarded the user's answers.
export function awaitPendingUserAnswers(
  toolCallId: string,
  timeoutMs: number = ASK_TIMEOUT_MS,
): Promise<string[][]> {
  return new Promise<string[][]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingQuestions.delete(toolCallId);
      reject(new Error(`Ask-user-question timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    pendingQuestions.set(toolCallId, { resolve, reject, timer });
  });
}

// ---- Tool definition ------------------------------------------------------

const MAX_QUESTIONS = 5;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 8;

const OptionSchema = Type.Object({
  label: Type.String({
    description: 'Short option label (1-5 words). The first option can be marked "(Recommended)".',
  }),
  description: Type.Optional(
    Type.String({
      description: 'Optional 1-sentence explanation of the option / its trade-offs.',
    }),
  ),
});

const QuestionSchema = Type.Object({
  question: Type.String({
    description: 'The full question text, exactly as you would phrase it to the user.',
  }),
  header: Type.Optional(
    Type.String({
      description: 'Short chip/tag (1-3 words) shown next to the question — e.g. "Theme", "Brand color".',
    }),
  ),
  multiSelect: Type.Optional(
    Type.Boolean({
      description: 'Set true if the user can pick multiple options. Default false (single-select).',
    }),
  ),
  options: Type.Array(OptionSchema, { minItems: MIN_OPTIONS, maxItems: MAX_OPTIONS }),
});

const AskUserQuestionSchema = Type.Object({
  questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: MAX_QUESTIONS }),
});

const askUserQuestionTool = defineTool({
  name: 'ask_user_question',
  label: 'Ask User Question',
  description:
    'Ask the user one or more structured clarifying questions during execution. Use when requirements are ambiguous and you cannot proceed without concrete decisions — e.g. "Light or dark mode?", "What is the primary brand color?", "Mobile, tablet, or desktop?". ' +
    `Each question has ${MIN_OPTIONS}-${MAX_OPTIONS} options with short labels and optional descriptions. The user picks from the options (or types a custom answer). Up to ${MAX_QUESTIONS} questions per call. ` +
    'Do NOT stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.',
  promptSnippet: 'Ask the user structured clarifying questions when requirements are ambiguous.',
  promptGuidelines: [
    `Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to ${MAX_QUESTIONS} questions per invocation.`,
    `Each question MUST have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Every option requires a concise label (1-5 words) and an optional description explaining the trade-off.`,
    'Set multiSelect: true when multiple answers are valid (e.g. "Which screens should this design cover?").',
    'If you recommend a specific option, make that the first option and append "(Recommended)" to its label.',
    'Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.',
    'After receiving answers, proceed with the design immediately — do not ask follow-up questions unless the user explicitly asked for something missing.',
  ],
  parameters: AskUserQuestionSchema,

  async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { questions: Array<{
      question: string; header?: string; multiSelect?: boolean;
      options: Array<{ label: string; description?: string }>;
    }> };

    // Validate.
    if (!typed.questions || typed.questions.length === 0) {
      return {
        content: [{ type: 'text', text: 'Error: no questions provided.' }],
        details: { error: 'no_questions' },
      };
    }
    for (const q of typed.questions) {
      if (q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) {
        return {
          content: [{ type: 'text', text: `Error: each question must have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Got ${q.options.length}.` }],
          details: { error: 'bad_option_count' },
        };
      }
    }

    // Emit the question event — the frontend renders a dialog from this.
    emitEvent({
      type: 'agent:ask_user_question',
      toolCallId,
      questions: typed.questions.map((q) => ({
        question: q.question,
        header: q.header,
        multiSelect: q.multiSelect ?? false,
        options: q.options.map((o) => ({ label: o.label, description: o.description })),
      })),
    });

    // Block until the user answers (or timeout).
    const answers = await new Promise<string[][]>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingQuestions.delete(toolCallId);
        reject(new Error('Ask-user-question timed out after 5 minutes'));
      }, ASK_TIMEOUT_MS);
      pendingQuestions.set(toolCallId, { resolve, reject, timer });
    });

    // Format the answers for the agent.
    if (answers.length === 1 && answers[0]?.length === 1 && answers[0][0] === '__cancelled__') {
      return {
        content: [{ type: 'text', text: 'The user cancelled the questionnaire. Ask them what they want to do next, or proceed with sensible defaults and note them in the design.' }],
        details: { cancelled: true },
      };
    }

    // Build a readable transcript of Q&A.
    const lines: string[] = ['The user answered:'];
    for (let i = 0; i < typed.questions.length; i++) {
      const q = typed.questions[i];
      const ans = answers[i] ?? [];
      lines.push(`Q${i + 1}: ${q.question}`);
      lines.push(`  → ${ans.join(', ') || '(no answer)'}`);
    }
    lines.push('Proceed with the design using these answers.');

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      details: { answers, cancelled: false },
    };
  },
});

export const tools = [askUserQuestionTool];
