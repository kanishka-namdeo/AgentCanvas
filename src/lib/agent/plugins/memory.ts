// Plugin: memory
//
// Long-term memory with semantic search. Inspired by pi-memory but
// re-implemented natively (no qmd dependency — uses a lightweight
// in-memory inverted index for keyword search, with optional Jaccard
// similarity for fuzzy matching).
//
// Storage layout (under .pi/agent/memory/):
//   MEMORY.md       — curated long-term memory (decisions, preferences, durable facts)
//   SCRATCHPAD.md   — checklist of things to keep in mind / fix later
//   daily/YYYY-MM-DD.md — append-only daily log
//
// Tools:
//   memory_write   — write to MEMORY.md or daily log
//   memory_read    — read any memory file
//   memory_search  — search across all memory files
//   scratchpad     — add/check/uncheck/clear items on the scratchpad
//   memory_forget  — delete matching entries (with recovery record)
//
// At session start, MEMORY.md + SCRATCHPAD.md are auto-injected into the
// system prompt (see runner-native.ts → resourceLoader.getAppendSystemPrompt).

import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---- Paths ----------------------------------------------------------------

const MEMORY_DIR = path.join(process.env.HOME ?? process.env.USERPROFILE ?? '~', '.pi', 'agent', 'memory');
const MEMORY_FILE = path.join(MEMORY_DIR, 'MEMORY.md');
const SCRATCHPAD_FILE = path.join(MEMORY_DIR, 'SCRATCHPAD.md');
const DAILY_DIR = path.join(MEMORY_DIR, 'daily');
const RECOVERY_DIR = path.join(MEMORY_DIR, 'recovery');

function ensureDirs(): void {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.mkdirSync(DAILY_DIR, { recursive: true });
    fs.mkdirSync(RECOVERY_DIR, { recursive: true });
  } catch {
    // Read-only filesystem or no HOME — tools will gracefully no-op.
  }
}

function todayDateStr(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function todayDailyFile(): string {
  return path.join(DAILY_DIR, `${todayDateStr()}.md`);
}

// ---- File I/O helpers ------------------------------------------------------

function appendLine(filePath: string, line: string): void {
  ensureDirs();
  try {
    fs.appendFileSync(filePath, line + '\n');
  } catch {
    // No-op — caller will see an empty readback.
  }
}

function readFileSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function listAllMemoryFiles(): string[] {
  ensureDirs();
  const files: string[] = [];
  if (fs.existsSync(MEMORY_FILE)) files.push(MEMORY_FILE);
  if (fs.existsSync(SCRATCHPAD_FILE)) files.push(SCRATCHPAD_FILE);
  try {
    for (const f of fs.readdirSync(DAILY_DIR)) {
      if (f.endsWith('.md')) files.push(path.join(DAILY_DIR, f));
    }
  } catch {
    // No daily dir yet.
  }
  return files;
}

// ---- Keyword search (Jaccard similarity) ----------------------------------

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

interface SearchResult {
  file: string;
  line: string;
  score: number;
}

function searchMemory(query: string, maxResults = 10): SearchResult[] {
  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) return [];
  const results: SearchResult[] = [];
  for (const file of listAllMemoryFiles()) {
    const content = readFileSafe(file);
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const score = jaccard(queryTokens, tokenize(line));
      if (score > 0.05) {
        results.push({ file, line, score });
      }
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}

// ---- Tools ----------------------------------------------------------------

const memoryWriteTool = defineTool({
  name: 'memory_write',
  label: 'Write Memory',
  description:
    'Write a memory entry to long-term storage. Use for: durable design decisions, user preferences, recurring patterns, project context that should survive across sessions. Two targets: "memory" (curated long-term, in MEMORY.md) or "daily" (today\'s append-only log).',
  promptSnippet: 'Save durable facts and design decisions to long-term memory.',
  promptGuidelines: [
    'Use memory_write for facts that should survive across sessions — design decisions, user preferences, recurring patterns.',
    'Use target="daily" for transient notes (today\'s work log); target="memory" for curated long-term facts.',
    'Each entry should be a single, self-contained sentence (e.g. "User prefers dark mode with #0b0f1a background")',
    'Do NOT save transient state (the current canvas, in-progress tool calls) — those live in the canvas / session store.',
  ],
  parameters: Type.Object({
    entry: Type.String({ description: 'The memory entry to write (a single self-contained sentence)' }),
    target: Type.Optional(Type.Union([
      Type.Literal('memory'),
      Type.Literal('daily'),
    ], { description: 'Where to write. "memory" = curated MEMORY.md; "daily" = today\'s daily log. Default "memory".' })),
    category: Type.Optional(Type.String({ description: 'Optional category tag (e.g. "preference", "decision", "brand"). Stored as a markdown comment.' })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { entry: string; target?: 'memory' | 'daily'; category?: string };
    const target = typed.target ?? 'memory';
    const filePath = target === 'daily' ? todayDailyFile() : MEMORY_FILE;
    const tag = typed.category ? `<!-- cat=${typed.category} -->` : '';
    const line = `${tag}${tag ? ' ' : ''}${typed.entry}`;
    appendLine(filePath, line);
    return {
      content: [{ type: 'text', text: `Saved to ${target}: "${typed.entry}"` }],
      details: { target, file: filePath },
    };
  },
});

const memoryReadTool = defineTool({
  name: 'memory_read',
  label: 'Read Memory',
  description: 'Read a memory file. Defaults to MEMORY.md (the curated long-term memory). Pass target="scratchpad" for the scratchpad, target="daily" for today\'s daily log, or target="all" for a summary of everything.',
  promptSnippet: 'Read previously-saved memory entries.',
  promptGuidelines: [
    'Call memory_read at the start of a turn to recall user preferences and design decisions.',
    'Use target="scratchpad" to see the user\'s open items / fix-later list.',
    'Use target="all" for a summary of every memory file (compact preview).',
  ],
  parameters: Type.Object({
    target: Type.Optional(Type.Union([
      Type.Literal('memory'),
      Type.Literal('daily'),
      Type.Literal('scratchpad'),
      Type.Literal('all'),
    ], { description: 'What to read. Default "memory".' })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { target?: 'memory' | 'daily' | 'scratchpad' | 'all' };
    const target = typed.target ?? 'memory';
    if (target === 'all') {
      const files = listAllMemoryFiles();
      if (files.length === 0) {
        return { content: [{ type: 'text', text: 'No memory files yet.' }], details: { count: 0 } };
      }
      const summary = files.map((f) => {
        const content = readFileSafe(f);
        const lines = content.split('\n').filter((l) => l.trim()).length;
        return `${path.basename(f)} (${lines} lines)`;
      }).join('\n');
      return {
        content: [{ type: 'text', text: `Memory files:\n${summary}` }],
        details: { count: files.length, files },
      };
    }
    const fileMap: Record<string, string> = {
      memory: MEMORY_FILE,
      daily: todayDailyFile(),
      scratchpad: SCRATCHPAD_FILE,
    };
    const filePath = fileMap[target] ?? MEMORY_FILE;
    const content = readFileSafe(filePath);
    if (!content.trim()) {
      return {
        content: [{ type: 'text', text: `(empty: ${target} has no entries yet)` }],
        details: { target, empty: true },
      };
    }
    return {
      content: [{ type: 'text', text: content }],
      details: { target, file: filePath, lineCount: content.split('\n').length },
    };
  },
});

const memorySearchTool = defineTool({
  name: 'memory_search',
  label: 'Search Memory',
  description: 'Search across all memory files using keyword similarity. Returns matching lines ranked by relevance (Jaccard similarity). Use this to recall specific past decisions or preferences.',
  promptSnippet: 'Search memory for past decisions and preferences.',
  promptGuidelines: [
    'Use memory_search when memory_read returns too much content and you need specific entries.',
    'Pass a natural-language query — the same keywords you would search a document for.',
    'Results are ranked by relevance; the top 3-5 are usually sufficient.',
  ],
  parameters: Type.Object({
    query: Type.String({ description: 'Natural-language query (e.g. "brand color preference", "mobile breakpoint")' }),
    limit: Type.Optional(Type.Number({ description: 'Max results (default 10)' })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { query: string; limit?: number };
    const results = searchMemory(typed.query, typed.limit ?? 10);
    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: `No memory entries match "${typed.query}".` }],
        details: { count: 0 },
      };
    }
    const lines = results.map((r, i) => `${i + 1}. [${(r.score * 100).toFixed(0)}%] ${path.basename(r.file)}: ${r.line}`);
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      details: { count: results.length, query: typed.query },
    };
  },
});

const scratchpadTool = defineTool({
  name: 'scratchpad',
  label: 'Scratchpad',
  description: 'Manage the scratchpad checklist (things to keep in mind / fix later). Actions: add, check, uncheck, clear, list.',
  promptSnippet: 'Manage a scratchpad of items to revisit later.',
  promptGuidelines: [
    'Use action="add" to jot down things to revisit later (e.g. "fix the alignment of the CTA").',
    'Use action="check" to mark an item as done; "uncheck" to reopen.',
    'Use action="list" to see the current scratchpad.',
    'Use action="clear" to wipe the scratchpad (use sparingly — only when starting fresh).',
  ],
  parameters: Type.Object({
    action: Type.Union([Type.Literal('add'), Type.Literal('check'), Type.Literal('uncheck'), Type.Literal('clear'), Type.Literal('list')]),
    item: Type.Optional(Type.String({ description: 'The item text (for "add") or matching substring (for "check"/"uncheck")' })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { action: 'add' | 'check' | 'uncheck' | 'clear' | 'list'; item?: string };
    ensureDirs();
    let content = readFileSafe(SCRATCHPAD_FILE);
    const lines = content.split('\n').filter((l) => l.trim());

    switch (typed.action) {
      case 'add': {
        if (!typed.item) {
          return { content: [{ type: 'text', text: 'Error: item is required for add.' }], details: { error: 'no_item' } };
        }
        lines.push(`- [ ] ${typed.item}`);
        fs.writeFileSync(SCRATCHPAD_FILE, lines.join('\n') + '\n');
        return {
          content: [{ type: 'text', text: `Added to scratchpad: "${typed.item}"` }],
          details: { action: 'add', item: typed.item },
        };
      }
      case 'check':
      case 'uncheck': {
        if (!typed.item) {
          return { content: [{ type: 'text', text: 'Error: item is required for check/uncheck.' }], details: { error: 'no_item' } };
        }
        const mark = typed.action === 'check' ? 'x' : ' ';
        let count = 0;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(typed.item.toLowerCase())) {
            lines[i] = lines[i].replace(/^-\s*\[[ x]\]/, `- [${mark}]`);
            count++;
          }
        }
        fs.writeFileSync(SCRATCHPAD_FILE, lines.join('\n') + '\n');
        return {
          content: [{ type: 'text', text: `${typed.action === 'check' ? 'Checked' : 'Unchecked'} ${count} item(s) matching "${typed.item}".` }],
          details: { action: typed.action, matched: count },
        };
      }
      case 'clear': {
        fs.writeFileSync(SCRATCHPAD_FILE, '');
        return {
          content: [{ type: 'text', text: 'Cleared the scratchpad.' }],
          details: { action: 'clear' },
        };
      }
      case 'list': {
        if (lines.length === 0) {
          return { content: [{ type: 'text', text: '(scratchpad is empty)' }], details: { count: 0 } };
        }
        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          details: { count: lines.length },
        };
      }
    }
  },
});

const memoryForgetTool = defineTool({
  name: 'memory_forget',
  label: 'Forget Memory',
  description: 'Delete matching memory entries and create a recovery record. Use sparingly — only when an entry is wrong or outdated. The deleted entries are saved to recovery/ for undo.',
  promptSnippet: 'Delete a wrong or outdated memory entry.',
  promptGuidelines: [
    'Use memory_forget only when an entry is wrong or outdated.',
    'Pass a query string; all matching lines (Jaccard similarity > 0.3) are deleted from MEMORY.md and today\'s daily log.',
    'A recovery record is saved to recovery/ — call memory_restore with the recovery id to undo.',
  ],
  parameters: Type.Object({
    query: Type.String({ description: 'Query string; matching entries are deleted' }),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { query: string };
    const recoveryId = `recovery-${Date.now()}`;
    const recoveryFile = path.join(RECOVERY_DIR, `${recoveryId}.json`);
    const deleted: Array<{ file: string; line: string }> = [];
    const queryTokens = tokenize(typed.query);

    for (const file of [MEMORY_FILE, todayDailyFile()]) {
      if (!fs.existsSync(file)) continue;
      const content = readFileSafe(file);
      const lines = content.split('\n');
      const kept: string[] = [];
      for (const line of lines) {
        if (!line.trim()) {
          kept.push(line);
          continue;
        }
        const score = jaccard(queryTokens, tokenize(line));
        if (score > 0.3) {
          deleted.push({ file, line });
        } else {
          kept.push(line);
        }
      }
      if (deleted.some((d) => d.file === file)) {
        fs.writeFileSync(file, kept.join('\n'));
      }
    }

    if (deleted.length === 0) {
      return {
        content: [{ type: 'text', text: `No memory entries match "${typed.query}".` }],
        details: { deleted: 0 },
      };
    }

    ensureDirs();
    fs.writeFileSync(recoveryFile, JSON.stringify({ query: typed.query, deleted, timestamp: Date.now() }, null, 2));
    return {
      content: [{ type: 'text', text: `Deleted ${deleted.length} entr${deleted.length === 1 ? 'y' : 'ies'}. Recovery id: ${recoveryId}.` }],
      details: { deleted: deleted.length, recoveryId },
    };
  },
});

export const tools = [memoryWriteTool, memoryReadTool, memorySearchTool, scratchpadTool, memoryForgetTool];

// ---- System prompt injection (called by runner-native.ts) ------------------

// Audit 1 P7: injection caps — MEMORY.md / scratchpad / daily logs grow
// without bound and used to ride the prompt at full length. Keep the TAIL
// (most recent entries) of each section.
const MEMORY_INJECT_CAP_LINES = 100;
const SCRATCHPAD_INJECT_CAP_LINES = 30;
const DAILY_INJECT_CAP_LINES = 50;

function tailLines(text: string, cap: number): string {
  const lines = text.trimEnd().split('\n');
  if (lines.length <= cap) return text.trim();
  return `… (${lines.length - cap} older line(s) omitted)\n${lines.slice(-cap).join('\n')}`;
}

export function getMemoryContextForPrompt(): string {
  const memory = readFileSafe(MEMORY_FILE);
  const scratchpad = readFileSafe(SCRATCHPAD_FILE);
  const today = readFileSafe(todayDailyFile());
  const yesterdayDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const yesterday = readFileSafe(path.join(DAILY_DIR, `${yesterdayDate}.md`));
  const parts: string[] = [];
  if (memory.trim()) parts.push(`=== MEMORY (long-term, curated) ===\n${tailLines(memory, MEMORY_INJECT_CAP_LINES)}`);
  if (scratchpad.trim()) parts.push(`=== SCRATCHPAD (fix-later items) ===\n${tailLines(scratchpad, SCRATCHPAD_INJECT_CAP_LINES)}`);
  if (today.trim()) parts.push(`=== TODAY'S LOG ===\n${tailLines(today, DAILY_INJECT_CAP_LINES)}`);
  if (yesterday.trim()) parts.push(`=== YESTERDAY'S LOG ===\n${tailLines(yesterday, DAILY_INJECT_CAP_LINES)}`);
  return parts.length > 0 ? parts.join('\n\n') : '';
}
