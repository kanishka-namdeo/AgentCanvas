// multitask.ts — Cursor /multitask adaptation for the canvas (research §4.5).
//
// Cursor's /multitask dispatches async subagents to work on tasks in
// parallel — but its v0 shipped WITHOUT collision prevention (admitted on
// the forum, raw p31). The canvas-native answer is REGION-SCOPED ISOLATION:
// decompose the request into per-screen subtasks, generate every screen in
// PARALLEL (staggered — same transport discipline as variant-generator),
// and apply each into its own disjoint canvas region. No two writers ever
// touch the same nodes because each writer gets its own lane.
//
// Pipeline (2 phases, ~1 + 1 wall-clock generation):
//   1. Decompose (ONE cheap LLM call): the request + existing canvas summary
//      → { sharedStyle, tasks[2-5] } where sharedStyle is the design
//      direction EVERY screen follows (one product, one look) and each task
//      is a self-contained screen brief.
//   2. Parallel generation (staggered Promise.all + one sequential retry per
//      failed task — the variant-generator pattern): each task → a complete
//      subtree spec (the pen_create_subtree node contract). The RUNNER
//      applies each spec at its region offset — this module never touches
//      the live canvas.
//
// Degradation ladder (every rung non-fatal):
//   - Decomposition fails / parses to <2 tasks → the runner falls through to
//     the normal single-agent path (the request is still handled).
//   - A screen generation fails twice → reported in notes; the other
//     screens still land.
//   - No LLM client → error result; the runner falls through.

import ZAI from 'z-ai-web-dev-sdk';
import type { LLMClientLike as LLMClient } from '../llm-retry';
import { callLLMWithRetry } from '../llm-retry';
import { getActiveLLM } from '../plugins/subagents';
import { extractSpecJson } from './variant-generator';

// ---- Public types ----------------------------------------------------------

export interface MultitaskTask {
  title: string;
  prompt: string;
}

export interface MultitaskDecomposition {
  /// Compact design direction shared by EVERY screen (one product, one look).
  sharedStyle: string;
  tasks: MultitaskTask[];
}

export interface MultitaskScreen {
  taskIndex: number;
  title: string;
  /** Parsed subtree spec (pen_create_subtree node contract), root at 0,0. */
  spec: Record<string, unknown>;
  nodeCount: number;
}

export interface MultitaskResult {
  decomposition: MultitaskDecomposition | null;
  screens: MultitaskScreen[];
  /// Per-task failure notes (surfaced in the turn summary + dev.log).
  notes: string[];
  generationMs: number;
  error?: string;
}

// ---- Budgets -----------------------------------------------------------------

const DECOMPOSE_TIMEOUT_MS = 60_000;
// Per-screen deadline. Live-verified 2026-08-30 (kimi-k2-5, /multitask E2E):
// a full-screen pen_create_subtree spends 80-140s in pure argument
// COMPOSITION before the single patch lands — 150s killed 3 of 4 workers
// mid-composition (each had exactly 1 tool call in flight). 240s covers the
// observed p95 plus one provider retry; the total budget still bounds the
// wall clock.
const SCREEN_GEN_TIMEOUT_MS = 240_000;
const TOTAL_BUDGET_MS = 600_000; // 10 min — K screens staggered 10s + retries
const MAX_TASKS = 5;
const STAGGER_MS = 10_000;

/** Race a promise against a timeout — settled either way, never hangs. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${Math.round(Math.max(ms, 0) / 1000)}s deadline`)),
      Math.max(ms, 1),
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ---- Phase 1: decomposition ----------------------------------------------------

const DECOMPOSE_SYSTEM_PROMPT = `You are a senior product designer decomposing a multi-screen design request for PARALLEL generation.
Return STRICT JSON only — no markdown fences, no commentary:
{"sharedStyle": "<2-3 sentences: the ONE design direction every screen follows — palette (hex values), typography scale, corner radius, elevation, mood + one reference product>", "tasks": [{"title": "<screen name>", "prompt": "<self-contained screen brief: purpose, the concrete sections/components it contains with realistic content, primary action>"}]}
Rules:
- 2 to 5 tasks (MAX ${MAX_TASKS}). Each task = ONE screen, buildable by an agent that sees ONLY this brief + sharedStyle.
- Screens must COHERE as one product: same sharedStyle, complementary purposes, consistent header/nav patterns where natural.
- Prompts must be SPECIFIC (components + realistic copy ideas), not "a settings screen".
- If the request describes a single screen only, return exactly 2 tasks by splitting it into sensible screens.`;

export async function decomposeMultitaskPrompt(
  prompt: string,
  llm?: LLMClient,
  signal?: AbortSignal,
  canvasSummary?: string,
): Promise<MultitaskDecomposition | null> {
  let client: LLMClient | undefined = llm ?? undefined;
  if (!client) {
    const active = getActiveLLM();
    if (active) client = active as LLMClient;
    else {
      try { client = (await ZAI.create()) as unknown as LLMClient; } catch { return null; }
    }
  }

  let content = '';
  try {
    const completion = await withTimeout(
      callLLMWithRetry(
        client as any,
        {
          messages: [
            { role: 'system', content: DECOMPOSE_SYSTEM_PROMPT },
            {
              role: 'user',
              content:
                `Request:\n${prompt}\n\n` +
                (canvasSummary ? `Existing canvas (screens already present — the new screens are additions, placed to their right):\n${canvasSummary}\n\n` : '') +
                'Decompose into the JSON now.',
            },
          ] as any,
          temperature: 0.3,
        },
        { maxRetries: 1, baseDelayMs: 2000 },
      ),
      DECOMPOSE_TIMEOUT_MS,
      'multitask decomposition',
    );
    content = completion?.choices?.[0]?.message?.content?.trim() || '';
  } catch {
    return null;
  }
  if (signal?.aborted) return null;

  // Defensive JSON extraction (same discipline as extractSpecJson): strip
  // fences, find the outermost {...} block, parse.
  const jsonText = content.replace(/```(?:json)?/gi, '').trim();
  const start = jsonText.indexOf('{');
  const end = jsonText.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: any;
  try { parsed = JSON.parse(jsonText.slice(start, end + 1)); } catch { return null; }

  const sharedStyle =
    typeof parsed?.sharedStyle === 'string' && parsed.sharedStyle.trim().length > 0
      ? parsed.sharedStyle.trim().slice(0, 1200)
      : 'Clean modern product design: near-white background, white cards with hairline borders, ONE restrained accent color, 24-32px spacing, weight-600 headings / 400 body, subtle shadows on interactive cards.';

  const tasks: MultitaskTask[] = Array.isArray(parsed?.tasks)
    ? parsed.tasks
        .filter((t: any) => t && typeof t.prompt === 'string' && t.prompt.trim().length > 0)
        .slice(0, MAX_TASKS)
        .map((t: any, i: number) => ({
          title: (typeof t.title === 'string' && t.title.trim() ? t.title.trim() : `Screen ${i + 1}`).slice(0, 60),
          prompt: t.prompt.trim().slice(0, 3000),
        }))
    : [];

  if (tasks.length < 2) return null;
  return { sharedStyle, tasks };
}

// ---- Phase 2: parallel screen generation ----------------------------------------

// Same node-tree contract as variant-generator's SPEC_SYSTEM_PROMPT /
// pen_create_subtree (kept in sync with the documented .pen schema).
const SCREEN_SPEC_SYSTEM_PROMPT = `You are a senior UI designer emitting ONE complete, high-fidelity screen as strict JSON for a design canvas.

The JSON MUST have exactly this shape:
{"title": "<screen name>", "spec": { <subtree root> }}

The subtree root (and every nested node) accepts these fields (all optional unless noted):
- type: "frame" | "rectangle" | "ellipse" | "text" | "line" | "group" | "icon" (root: frame)
- name: layer name
- x, y: position relative to the PARENT (root: absolute canvas coords; start root at x:0, y:0)
- width, height: px numbers, OR "fit_content" (hug content) OR "fill_container"
- children: array of nested nodes with the same shape
- fill: hex color string (frames may be "none" for transparent)
- text: string (for type:"text" nodes; also content)
- fontSize, fontWeight, fontFamily, lineHeight, letterSpacing, textAlign, color (text styling)
- radius: number (uniform) or radii: {topLeft, topRight, bottomRight, bottomLeft}
- shadow: {x, y, blur, color, spread?, inset?} — 8-digit hex with alpha, e.g. {x:0, y:4, blur:6, color:"#0000001a"}
- gradient: {type:"linear"|"radial", angle, stops:[{offset, color}]}
- autoLayout: {direction:"horizontal"|"vertical", gap, padding, alignX, alignY} — flexbox for frames
- opacity: 0..1
- icon: lucide icon name (for type:"icon")

CRITICAL — OUTPUT SCHEMA (models get this wrong; read carefully):
The spec is a NESTED NODE TREE where every node has "type" and optional "children".
It is NOT an abstract UI description. FORBIDDEN keys/patterns (they will be discarded):
- "ui_components", "components", "sections", "elements" as top-level arrays
- "layout": {"structure": "flex_row"} style descriptors — use autoLayout instead
- "positioning", "max_width", "content", "variant" descriptor objects
- describing what SHOULD be built instead of emitting the tree

QUALITY BAR (non-negotiable):
- Realistic, domain-appropriate copy for every text node (NO lorem ipsum, NO "Text", NO "Label" placeholders)
- Complete type hierarchy: display/H1 28-40px w700-800, H2 20-24px w600-700, body 14-16px w400, labels/captions 11-12px w500; negative letter-spacing on large headings (-0.4 to -0.8)
- Explicit sizes on containers (avoid fit_content on mid-tree frames); every text node needs width (or fill_container inside an autoLayout parent)
- Card elevation: subtle shadow {x:0, y:1, blur:2, color:"#0000000d"} minimum on interactive cards; deeper (y:4, blur:6) for raised states
- The screen is COMPLETE: header/nav, all content sections, primary actions, states a real product would show
- Root frame = the full screen with an explicit width/height (e.g. 390x844 mobile, 1280x800 desktop web, 1440x900 marketing) and the screen background fill`;

async function generateOneScreen(
  task: MultitaskTask,
  sharedStyle: string,
  llm: LLMClient,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ spec: Record<string, unknown>; nodeCount: number } | null> {
  const completion = await withTimeout(
    callLLMWithRetry(
      llm as any,
      {
        messages: [
          { role: 'system', content: SCREEN_SPEC_SYSTEM_PROMPT },
          {
            role: 'user',
            content:
              `Build THIS screen (one of a multi-screen set — follow the shared style so the set coheres):\n${task.prompt}\n\n` +
              `SHARED DESIGN DIRECTION (every screen in the set follows this):\n${sharedStyle}\n\n` +
              `This is a FORMAT task, not a design brief: TRANSLATE the screen into the node-tree JSON from the system prompt. ` +
              `Return the JSON now — {"title": "${task.title}", "spec": {...}} — spec root at x:0, y:0 with an explicit screen size.`,
          },
        ] as any,
        temperature: 0.7,
      },
      { maxRetries: 2, baseDelayMs: 2500 },
    ),
    timeoutMs,
    `multitask screen "${task.title}"`,
  );
  if (signal?.aborted) return null;
  const content = completion?.choices?.[0]?.message?.content?.trim() || '';
  if (!content) return null;
  const spec = extractSpecJson(content);
  if (!spec) return null;
  const nodeCount = countNodes(spec);
  if (nodeCount < 3 || nodeCount > 300) return null;
  return { spec, nodeCount };
}

function countNodes(node: Record<string, unknown>): number {
  let n = 1;
  const kids = node.children;
  if (Array.isArray(kids)) {
    for (const k of kids) {
      if (k && typeof k === 'object') n += countNodes(k as Record<string, unknown>);
    }
  }
  return n;
}

export interface MultitaskDispatchParams {
  prompt: string;
  llm?: LLMClient;
  signal?: AbortSignal;
  /// Short existing-canvas summary for the decomposition (screen names/sizes).
  canvasSummary?: string;
  onProgress?: (text: string) => void;
  /// Fired when a screen's parallel generation starts (runner → subagent_dispatch card).
  onTaskStart?: (task: MultitaskTask, index: number, total: number) => void;
  /// Fired when a screen's generation settles (runner → subagent_result card).
  onTaskDone?: (task: MultitaskTask, index: number, ok: boolean, detail: string) => void;
}

export async function dispatchMultitask(params: MultitaskDispatchParams): Promise<MultitaskResult> {
  const startTime = Date.now();
  const deadline = startTime + TOTAL_BUDGET_MS;
  const remaining = () => deadline - Date.now();
  const notes: string[] = [];
  const progress = (text: string) => {
    try { params.onProgress?.(text); } catch { /* best-effort */ }
  };
  const throwIfAborted = () => {
    if (params.signal?.aborted) throw new Error('multitask dispatch aborted — run was stopped');
  };

  let llm: LLMClient | undefined = params.llm ?? undefined;
  if (!llm) {
    const active = getActiveLLM();
    if (active) llm = active as LLMClient;
    else {
      try { llm = (await ZAI.create()) as unknown as LLMClient; } catch {
        return { decomposition: null, screens: [], notes, generationMs: Date.now() - startTime, error: 'No LLM client available for multitask.' };
      }
    }
  }

  // ---- Phase 1: decompose ----------------------------------------------------
  progress('Decomposing the request into per-screen tasks…');
  const decomposition = await decomposeMultitaskPrompt(params.prompt, llm, params.signal, params.canvasSummary);
  if (!decomposition) {
    return {
      decomposition: null,
      screens: [],
      notes,
      generationMs: Date.now() - startTime,
      error: 'Decomposition failed (no LLM / unparseable) — falling back to the single-agent path.',
    };
  }
  throwIfAborted();
  progress(`Decomposed into ${decomposition.tasks.length} screens (${decomposition.tasks.map((t) => t.title).join(' · ')}) — generating in parallel…`);

  // ---- Phase 2: staggered parallel generation ---------------------------------
  const wave = await Promise.all(
    decomposition.tasks.map(async (task, i) => {
      try {
        // Fire the dispatch card at actual START (staggered start = honest timing).
        const delayMs = remaining() > 3 * STAGGER_MS ? STAGGER_MS * i : Math.min(2_000, Math.max(0, Math.floor(remaining() / 4)));
        if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
        params.onTaskStart?.(task, i, decomposition.tasks.length);
        const result = await generateOneScreen(task, decomposition.sharedStyle, llm!, params.signal, Math.min(SCREEN_GEN_TIMEOUT_MS, Math.max(1, remaining())));
        params.onTaskDone?.(task, i, !!result, result ? `${result.nodeCount} nodes` : 'generation failed');
        return { task, result, error: undefined as string | undefined };
      } catch (err) {
        params.onTaskDone?.(task, i, false, err instanceof Error ? err.message : String(err));
        return { task, result: null, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  // Sequential retry for transport-starved screens (empty wire, no contention).
  const failed = wave.filter((w) => !w.result);
  if (failed.length > 0) {
    progress(`${wave.length - failed.length}/${wave.length} screens generated — retrying failures sequentially…`);
    for (const w of failed) {
      throwIfAborted();
      if (remaining() < SCREEN_GEN_TIMEOUT_MS * 0.6) {
        notes.push(`"${w.task.title}": sequential retry skipped (budget)`);
        continue;
      }
      try {
        const result = await generateOneScreen(w.task, decomposition.sharedStyle, llm!, params.signal, Math.min(SCREEN_GEN_TIMEOUT_MS, remaining()));
        if (result) {
          w.result = result;
          w.error = undefined;
          notes.push(`"${w.task.title}": recovered on sequential retry`);
          params.onTaskDone?.(w.task, decomposition.tasks.indexOf(w.task), true, `${result.nodeCount} nodes (recovered on retry)`);
        }
      } catch {
        // leave failed — recorded below
      }
    }
  }

  const screens: MultitaskScreen[] = wave
    .filter((w) => w.result)
    .map((w, idx) => ({ taskIndex: idx, title: w.task.title, spec: w.result!.spec, nodeCount: w.result!.nodeCount }));
  for (const w of wave) {
    if (!w.result) notes.push(`"${w.task.title}": generation failed${w.error ? ` (${w.error})` : ''}`);
  }

  return {
    decomposition,
    screens,
    notes,
    generationMs: Date.now() - startTime,
    ...(screens.length === 0 ? { error: 'All screen generations failed — falling back to the single-agent path.' } : {}),
  };
}
