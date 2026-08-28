// Variant generator sub-agent — the "go wide" pattern (R1 pattern 8/9).
//
// For AMBIGUOUS / under-specified creation prompts ("a pricing page",
// "a profile card") a single guess commits the whole turn to one design
// direction. Shipped products trade compute for quality instead:
//   - Figma's design agent: "go wide: quickly generate distinct stylistic
//     approaches… Compare multiple checkout flows… ask for three different
//     information architectures."
//   - tldraw Fairies: multiple agents explore in parallel, a review pass
//     picks the best combined output.
//
// This module implements the AgentCanvas adaptation:
//   1. K=3 COMPLETE subtree specs are generated in PARALLEL completions
//      (staggered launches — see transport note below; wall-clock ≈ one
//      generation), each seeded with a distinct design direction
//      (minimal-light / bold-vibrant / dark-premium, or caller-provided).
//   2. Each spec is applied to a THROWAWAY clone of the document, resolved,
//      and rendered to PNG — the real canvas is never touched during
//      exploration.
//   3. One VLM judge call scores the K renders side-by-side (a single
//      composited image) and picks a winner.
//   4. Only the winning spec is returned for application. Losers never
//      touch the document — no cleanup, no canvas pollution.
//
// Degradation ladder (every rung is non-fatal):
//   - VLM judge fails (no vision model / endpoint down) → heuristic pick:
//     fewest resolver warnings, tie-break on node count.
//   - Only 1 of K specs parsed → that one wins, judged = false.
//   - 0 specs parsed → error result; the caller tells the agent to fall
//     back to pen_create_subtree.
//
// Schema robustness (live kimi-k2-5 findings, three independent failure
// modes observed):
//   a. The model substitutes its own ontology (ui_components / sections /
//      content-plan JSON) for the node tree → a COERCION layer salvages
//      node-shaped subtrees from near-miss schemas.
//   b. Even coerced output can miss → ONE bounded repair round-trip
//      re-shapes the failed content (models convert reliably).
//   c. Un-staggered parallel big generations starve each other on
//      constrained transports (single SSH tunnels) → staggered launches
//      + one sequential retry per failed variant.

import ZAI from 'z-ai-web-dev-sdk';
import type { LLMClientLike as LLMClient } from '../llm-retry';
import { callLLMWithRetry } from '../llm-retry';
import { getActiveLLM } from '../plugins/subagents';

// ---- Public types ----------------------------------------------------------

export interface VariantSpec {
  /** Short direction label, e.g. "Minimal Light". */
  direction: string;
  /** The parsed subtree root (same loose shape pen_create_subtree takes). */
  spec: Record<string, unknown>;
  /** Resolver warnings when applied to a throwaway clone (heuristic input). */
  warningCount: number;
  /** Node count of the spec (heuristic tie-break input). */
  nodeCount: number;
  /** PNG render of the variant applied to the throwaway clone. */
  png?: Buffer;
}

export interface VariantJudgeResult {
  /** Index of the winning variant (into the variants array). */
  winnerIndex: number;
  /** 0-10 scores per variant (heuristic fallback scores are estimates). */
  scores: number[];
  /** One-sentence justification. */
  reason: string;
  /** How the winner was chosen. */
  method: 'vlm' | 'heuristic' | 'single-candidate' | 'all-failed';
}

export interface VariantGenerationResult {
  /** Parsed variants (specs that survived JSON extraction + node caps). */
  variants: VariantSpec[];
  /** Judge outcome — null when every spec failed to parse. */
  judge: VariantJudgeResult | null;
  /** Wall-clock ms of the parallel generation phase. */
  generationMs: number;
  /** Non-fatal notes for the tool result text. */
  notes: string[];
  /** Fatal error (all specs failed / llm unavailable). */
  error?: string;
}

// ---- Default direction seeds -------------------------------------------------
//
// Three maximally-distinct directions so the winner carries real
// information ("the user's prompt implies dark-premium" is a decision a
// single completion can't make). The caller can override with its own.

export const DEFAULT_VARIANT_DIRECTIONS: Array<{ label: string; seed: string }> = [
  {
    label: 'Minimal Light',
    seed:
      'Airy light theme: near-white background (#f8fafc), white cards with hairline borders (#e2e8f0), ' +
      'ONE restrained brand accent (indigo #4f46e5 or sky #0ea5e9), generous 24-32px whitespace, ' +
      'weight-600 headings, 400 body, subtle sm shadows only on interactive cards. Stripe/Linear-like.',
  },
  {
    label: 'Bold Vibrant',
    seed:
      'Confident colorful theme: saturated primary (violet #7c3aed or emerald #059669) with a contrasting ' +
      'accent, gradient fills on hero/CTA (two different-ramp stops), pill radii, md/lg shadows, big ' +
      'display headings (32-48px weight 700), colored chips/labels. Figma/Notion-marketing-like energy.',
  },
  {
    label: 'Dark Premium',
    seed:
      'Dark theme: #0b0f1a background, #1e293b surfaces, #334155 borders, high-contrast #f1f5f9 text, ' +
      'ONE luminous accent (#38bdf8 or #a78bfa) used sparingly on CTAs and active states, lg shadows, ' +
      'subtle borders instead of heavy fills. Vercel/Raycast-like sophistication.',
  },
];

// ---- Spec-generation prompt ---------------------------------------------------
//
// Distilled from the system prompt's CRITICAL rules only (type scale,
// spacing, container sizing, text width, elevation) — compact enough to
// keep the sub-agent completion fast, strict enough to keep the specs
// renderable. Same node-shape contract as pen_create_subtree.

const SPEC_SYSTEM_PROMPT = `You are a senior UI designer emitting a complete, high-fidelity component tree as strict JSON for a design canvas.

The JSON MUST have exactly this shape:
{"direction": "<short label>", "spec": { <subtree root> }}

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
Every visual thing (navbar, card, button, text, icon) must be a NODE with a "type" field.

EXAMPLE (compact form — emit the same shape, do NOT copy this content):
{"direction":"Minimal Light","spec":{"type":"frame","name":"PricingCard","width":320,"height":"fit_content","fill":"#ffffff","radius":12,"shadow":{"x":0,"y":4,"blur":6,"color":"#0000001a"},"autoLayout":{"direction":"vertical","gap":12,"padding":24},"children":[{"type":"text","name":"PlanTitle","text":"Pro","fontSize":20,"fontWeight":600,"color":"#0f172a"},{"type":"text","name":"Price","text":"$19/mo","fontSize":30,"fontWeight":700,"color":"#0f172a"},{"type":"frame","name":"CtaButton","width":"fill_container","height":44,"fill":"#4f46e5","radius":8,"autoLayout":{"direction":"horizontal","gap":8,"alignX":"center","alignY":"center"},"children":[{"type":"text","name":"CtaLabel","text":"Choose Pro","fontSize":14,"fontWeight":500,"color":"#ffffff"}]}]}}

Emit COMPACT JSON (single line or minimal whitespace — no pretty-printing, no comments).

NON-NEGOTIABLE DESIGN RULES:
1. Container sizing: content-sized containers (cards, panels, forms, lists) MUST use height:"fit_content".
   Fixed heights ONLY for chrome: navbar 64, button 40-48, input 48, avatar 40-80.
2. Text width: single-line text needs width >= text.length x fontSize x 0.62 (x0.68 for weight 700).
   Text children may omit height entirely (auto-estimated from fontSize).
3. Type scale: caption 12, label 14, body 16, subtitle 20, h3 24, h2 30, h1 38, display 48.
   Weights: body 400, labels 500, section heads 600, page titles 700.
4. Spacing on the 8px grid: 4, 8, 12, 16, 24, 32, 48, 64, 80. Page padding 24-32 (web) / 16 (mobile).
   Radius: sm 6 (inputs), md 8 (buttons), lg 12 (cards), xl 16 (modals), pill 9999 (avatars/toggles).
5. Every elevated card/button needs a shadow ({x:0, y:4, blur:6, color:"#0000001a"} or stronger).
   A bare flat rectangle with no shadow/radius is a WIREFRAME, not a finished layer.
6. Use autoLayout on containers ({direction:"vertical", gap:16, padding:24}) so children flow —
   children of auto-layout parents may omit x/y.
7. Real content only — real-sounding names, numbers, labels (never "Lorem ipsum" or "Text here").
8. Icons: type:"icon" nodes with icon:"<lucide-name>" (e.g. "check", "zap", "credit-card").
9. Total tree size: 25-90 nodes. Complete but not bloated.

OUTPUT: Respond with the SINGLE JSON object only — no markdown fences, no commentary.`;

// ---- Repair prompt -------------------------------------------------------------
//
// Second-chance conversion for outputs that used the wrong schema. Pure
// transcription: keep the design + content, change only the shape.

const REPAIR_SYSTEM_PROMPT = `You are a format converter. You receive a design described in the WRONG JSON schema and must re-emit it in the REQUIRED node-tree schema. This is pure transcription — keep the design, content, copy, and styling decisions EXACTLY as given; change ONLY the JSON shape.

REQUIRED output shape:
{"direction": "<keep the original label>", "spec": { <node tree> }}

Node tree rules — every visual element is a NODE object:
- Fields: type ("frame"|"rectangle"|"ellipse"|"text"|"line"|"group"|"icon"), name, x, y, width, height, children[], fill (hex), text, fontSize, fontWeight, color, radius, shadow {x,y,blur,color}, gradient {type,angle,stops[]}, autoLayout {direction,gap,padding,alignX,alignY}, opacity, icon (lucide name).
- width/height: px numbers, or "fit_content", or "fill_container".
- Content-sized containers (cards, panels, lists) use height:"fit_content". Fixed heights only for chrome: navbar 64, button 40-48, input 48, avatar 40-80.
- Containers get autoLayout {direction:"vertical"|"horizontal", gap, padding} and children may omit x/y.
- Real content from the source (never placeholder text). Type scale: 12/14/16/20/24/30/38/48. Shadows on elevated cards: {x:0,y:4,blur:6,color:"#0000001a"}.
- Map the source's semantic keys ("headline"→text node, "plans"→card frames, "features"→text rows, "cta"→button frame, "toggle"→segmented control, "hero"→header frame with gradient). Icons become type:"icon" nodes.
- 25-90 nodes total. Emit COMPACT JSON.

Respond with the SINGLE JSON object only — no markdown fences, no commentary.`;

// ---- VLM judge prompt ---------------------------------------------------------

const JUDGE_SYSTEM_PROMPT = `You are a senior design lead judging A/B/C design variants rendered side by side. Each variant is labeled above its render (e.g. "VARIANT A — Minimal Light").

Judge which variant BEST fulfills the user's request considering:
1. Prompt fidelity — contains every element the request implies, with real content.
2. Visual craft — hierarchy, spacing, color discipline, typography, component polish (shadows, radii, borders).
3. Professional finish — would this pass as a real product screen (Stripe/Linear/Vercel caliber)?
4. Fewest rendering defects — clipped text, overflowing children, misaligned stacks, invisible elements.

Output ONLY this JSON:
{"winner": "A" | "B" | "C", "scores": {"A": <1-10>, "B": <1-10>, "C": <1-10>}, "reason": "<one sentence>"}
Score every variant even the ones that lose. No markdown fences, no commentary.`;

// ---- Public API ---------------------------------------------------------------

export interface VariantDispatchParams {
  /** The user's creation request, verbatim. */
  request: string;
  /** Optional caller-provided directions (1-4). Defaults to the 3 seeds. */
  directions?: string[];
  /** Number of variants (2-3). Default 3. */
  variantCount?: number;
  /** LLM client override (defaults to the runner-armed active LLM, then ZAI). */
  llm?: LLMClient;
  /**
   * Render callback: applies a spec to a throwaway doc clone and returns
   * {png, warningCount, nodeCount}. Injected by the tool so this module
   * stays free of canvas imports (testable in isolation).
   */
  renderVariant?: (spec: Record<string, unknown>) => Promise<{ png: Buffer; warningCount: number; nodeCount: number } | null>;
}

export async function dispatchVariantGeneration(
  params: VariantDispatchParams,
): Promise<VariantGenerationResult> {
  const startTime = Date.now();
  const notes: string[] = [];
  const count = Math.max(2, Math.min(3, params.variantCount ?? 3));

  let llm: LLMClient | undefined = params.llm ?? undefined;
  if (!llm) {
    const active = getActiveLLM();
    if (active) {
      llm = active as LLMClient;
    } else {
      try {
        llm = (await ZAI.create()) as unknown as LLMClient;
      } catch {
        return {
          variants: [],
          judge: null,
          generationMs: Date.now() - startTime,
          notes,
          error: 'No LLM client available for variant generation (no active runner LLM, ZAI.create failed).',
        };
      }
    }
  }

  // Resolve the direction seeds: caller-provided labels map onto the 3
  // default SEED descriptions when the label matches, else the raw string
  // is used as the full seed.
  const provided = params.directions?.filter((d) => typeof d === 'string' && d.trim().length > 0) ?? [];
  const directionPairs =
    provided.length >= 2
      ? provided.slice(0, count).map((label) => ({
          label: label.trim().slice(0, 40),
          seed: label.trim(),
        }))
      : DEFAULT_VARIANT_DIRECTIONS.slice(0, count);
  if (provided.length === 1) {
    // One custom direction + two defaults — keeps diversity.
    directionPairs[0] = { label: provided[0].trim().slice(0, 40), seed: provided[0].trim() };
  }

  // ---- 1. Parallel spec generation (staggered; wall-clock ~= 1-2 completions)
  //
  // Launches are STAGGERED (15s apart): on healthy endpoints the parallel
  // fast path still wins; on constrained transports (single SSH tunnels,
  // per-connection limits) un-staggered parallel big generations starve
  // each other past idle-timeout limits (live finding: 3 un-staggered
  // calls through one pinggy tunnel — 1 completed at ~80s, 2 died at
  // ~110s). Callers that fail the first wave get ONE sequential retry in
  // step 1b (empty wire, no contention).
  const generateOne = async (label: string, seed: string) => {
    const completion = await callLLMWithRetry(
      llm as any,
      {
        messages: [
          { role: 'system', content: SPEC_SYSTEM_PROMPT },
          {
            role: 'user',
            content:
              `Design request:\n${params.request}\n\n` +
              `Design direction for THIS variant (follow it decisively):\n${seed}\n\n` +
              `This is a FORMAT task, not a design brief: TRANSLATE the request + direction into ` +
              `the node-tree JSON from the system prompt (frames/text/icons with type+children — ` +
              `NOT ui_components / sections / content plans). Return the JSON now — ` +
              `{"direction": "${label}", "spec": {...}} — spec root at x:0, y:0.`,
          },
        ] as any,
        temperature: 0.8, // DIVERSE directions are the point — lean into it.
      },
      { maxRetries: 2, baseDelayMs: 2500 },
    );
    return completion?.choices?.[0]?.message?.content?.trim() || '';
  };

  const STAGGER_MS = 15_000;
  const generation = await Promise.all(
    directionPairs.map(async ({ label, seed }, i) => {
      try {
        if (i > 0) await new Promise((r) => setTimeout(r, STAGGER_MS * i));
        const content = await generateOne(label, seed);
        return { label, seed, content };
      } catch (err) {
        return {
          label,
          seed,
          content: '',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  // ---- 1b. Sequential retry for transport-failed variants -------------------
  //
  // By now the staggered wave is done — the wire is empty. Retry each
  // failed call ONE at a time (no contention). Bounded: one extra attempt
  // per failed variant.
  for (const g of generation) {
    if (g.content || !('error' in g)) continue;
    try {
      const content = await generateOne(g.label, g.seed);
      if (content) {
        g.content = content;
        delete (g as { error?: string }).error;
        notes.push(`variant "${g.label}": recovered on sequential retry`);
      }
    } catch {
      // leave failed — the parse loop below records it
    }
  }

  // ---- 2. Parse each spec (defensive JSON extraction + repair round) --------
  //
  // Live finding (kimi-k2-5): freeform generation sometimes substitutes the
  // model's own ontology (ui_components / content-plan shapes) for the node
  // tree, even with an example in the system prompt. But the SAME model
  // reliably re-shapes EXISTING content into a given format (it emits valid
  // node trees via pen_create_subtree tool calls all day). So: on parse
  // failure, ONE bounded repair call that converts the failed output —
  // content preserved, format fixed.
  const parsed: VariantSpec[] = [];
  for (const g of generation) {
    if (!g.content) {
      notes.push(`variant "${g.label}": generation failed${'error' in g && g.error ? ` (${g.error})` : ''}`);
      continue;
    }
    let spec = extractSpecJson(g.content);
    let repaired = false;
    if (!spec && g.content.length > 40) {
      try {
        const repair = await callLLMWithRetry(
          llm as any,
          {
            messages: [
              { role: 'system', content: REPAIR_SYSTEM_PROMPT },
              {
                role: 'user',
                content:
                  `The design content to convert (produced by another model pass — it used the WRONG format):\n` +
                  `${g.content.slice(0, 12_000)}\n\n` +
                  `Convert this EXACT design into the required node-tree JSON now. Keep every section, ` +
                  `plan, price, feature, and label — do not redesign it. Respond with the JSON object only.`,
              },
            ] as any,
            temperature: 0.1, // faithful conversion, not re-design
          },
          { maxRetries: 1, baseDelayMs: 2000 },
        );
        const repairedContent = repair?.choices?.[0]?.message?.content?.trim() || '';
        const repairedSpec = extractSpecJson(repairedContent);
        if (repairedSpec) {
          spec = repairedSpec;
          repaired = true;
        }
      } catch {
        // repair is best-effort — fall through to the skip below
      }
    }
    if (!spec) {
      notes.push(`variant "${g.label}": no parseable JSON spec (repair failed)`);
      continue;
    }
    if (repaired) notes.push(`variant "${g.label}": needed one format-repair round-trip`);
    const nodeCount = countNodes(spec);
    if (nodeCount < 3) {
      notes.push(`variant "${g.label}": spec too small (${nodeCount} nodes) — skipped`);
      continue;
    }
    if (nodeCount > 300) {
      notes.push(`variant "${g.label}": spec too large (${nodeCount} nodes) — skipped`);
      continue;
    }
    parsed.push({
      direction: g.label,
      spec,
      warningCount: 0,
      nodeCount,
    });
  }

  if (parsed.length === 0) {
    return {
      variants: [],
      judge: null,
      generationMs: Date.now() - startTime,
      notes,
      error: 'All variant generations failed to parse — fall back to pen_create_subtree.',
    };
  }

  // ---- 3. Render each variant on the throwaway canvas ----------------------
  if (params.renderVariant) {
    await Promise.all(
      parsed.map(async (v) => {
        try {
          const rendered = await params.renderVariant!(v.spec);
          if (rendered) {
            v.png = rendered.png;
            v.warningCount = rendered.warningCount;
            v.nodeCount = rendered.nodeCount;
          }
        } catch (err) {
          notes.push(`variant "${v.direction}": render failed (${err instanceof Error ? err.message : String(err)})`);
        }
      }),
    );
  }

  // ---- 4. Judge: VLM pick → heuristic fallback ------------------------------
  const judge = await judgeVariants({ request: params.request, variants: parsed, llm });
  if (judge.method === 'heuristic') {
    notes.push('VLM judge unavailable — winner picked by heuristic (fewest resolver warnings).');
  }

  return {
    variants: parsed,
    judge,
    generationMs: Date.now() - startTime,
    notes,
  };
}

// ---- Judge --------------------------------------------------------------------

async function judgeVariants(args: {
  request: string;
  variants: VariantSpec[];
  llm?: LLMClient;
}): Promise<VariantJudgeResult> {
  const { request, variants } = args;

  // Single candidate: no judging needed.
  if (variants.length === 1) {
    return {
      winnerIndex: 0,
      scores: [estimateScore(variants[0])],
      reason: 'Only one variant parsed successfully.',
      method: 'single-candidate',
    };
  }

  // VLM judge — needs every variant rendered.
  const renderable = variants.every((v) => v.png);
  if (renderable) {
    try {
      const composite = await compositeVariantPngs(
        variants.map((v) => ({ label: v.direction, png: v.png! })),
      );
      const labels = variants.map((_, i) => String.fromCharCode(65 + i)).join('/');
      const completion = await callLLMWithRetry(
        (args.llm ?? (await ZAI.create())) as any,
        {
          messages: [
            { role: 'system', content: JUDGE_SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text:
                    `User request:\n${request}\n\n` +
                    `${variants.length} variants (labeled VARIANT ${labels}) are rendered side by side in the image. ` +
                    `Judge them and return the JSON now.`,
                },
                {
                  type: 'image_url',
                  image_url: { url: `data:image/png;base64,${composite.toString('base64')}`, detail: 'high' },
                },
              ],
            },
          ] as any,
          temperature: 0.2,
        },
        { maxRetries: 1, baseDelayMs: 2000 },
      );
      const content = completion?.choices?.[0]?.message?.content?.trim() || '';
      const verdict = extractJsonBlock(content);
      if (verdict && typeof verdict.winner === 'string') {
        const winnerIdx = verdict.winner.toUpperCase().charCodeAt(0) - 65;
        if (winnerIdx >= 0 && winnerIdx < variants.length) {
          const scores = variants.map((_, i) => {
            const key = String.fromCharCode(65 + i);
            const s = verdict.scores?.[key];
            return typeof s === 'number' ? Math.max(1, Math.min(10, s)) : estimateScore(variants[i]);
          });
          return {
            winnerIndex: winnerIdx,
            scores,
            reason:
              typeof verdict.reason === 'string' && verdict.reason.length > 0
                ? verdict.reason
                : `VLM judge picked variant ${verdict.winner}.`,
            method: 'vlm',
          };
        }
      }
    } catch {
      // fall through to heuristic
    }
  }

  // Heuristic: fewest resolver warnings, tie-break node count (richer but
  // not bloated), final tie-break first.
  let best = 0;
  for (let i = 1; i < variants.length; i++) {
    const a = variants[i];
    const b = variants[best];
    if (a.warningCount < b.warningCount) best = i;
    else if (a.warningCount === b.warningCount && a.nodeCount > b.nodeCount) best = i;
  }
  return {
    winnerIndex: best,
    scores: variants.map((v) => estimateScore(v)),
    reason: `Heuristic pick: fewest resolver warnings (${variants[best].warningCount}) of ${variants.length} variants.`,
    method: 'heuristic',
  };
}

/// Rough quality estimate for score arrays when the judge didn't provide
/// one — deterministic, warning-count driven, never shown as ground truth.
function estimateScore(v: VariantSpec): number {
  const base = v.png ? 7 : 5;
  return Math.max(1, Math.min(10, base - Math.min(4, v.warningCount)));
}

// ---- Composite renderer ---------------------------------------------------------

/**
 * Compose variant PNGs side-by-side into ONE labeled image for the judge.
 * Scales every render to a uniform 760px column height, adds a 48px label
 * strip above each (SVG rasterized — DejaVu falls back fine), 24px gutters.
 */
export async function compositeVariantPngs(
  variants: Array<{ label: string; png: Buffer }>,
): Promise<Buffer> {
  const sharp = (await import('sharp')).default;

  const COL_W = 760;
  const LABEL_H = 48;
  const GUTTER = 24;
  const MARGIN = 16;

  const cols: Array<{ labelBuf: Buffer; imgBuf: Buffer; colHeight: number }> = [];
  for (const v of variants) {
    // Scale to fit column width; height follows aspect.
    const img = sharp(v.png).resize({ width: COL_W, fit: 'inside', withoutEnlargement: false });
    const imgBuf = await img.png().toBuffer();
    const meta = await sharp(imgBuf).metadata();
    const colHeight = (meta.height ?? 500) + LABEL_H;
    const safeLabel = escapeXml(v.label).slice(0, 44);
    const labelSvg = Buffer.from(
      `<svg width="${COL_W}" height="${LABEL_H}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="#0f172a"/>` +
        `<text x="16" y="31" font-family="DejaVu Sans, sans-serif" font-size="22" font-weight="bold" fill="#ffffff">VARIANT ${String.fromCharCode(65 + cols.length)} — ${safeLabel}</text>` +
        `</svg>`,
    );
    const labelBuf = await sharp(labelSvg).png().toBuffer();
    cols.push({ labelBuf, imgBuf, colHeight });
  }

  const totalW = MARGIN * 2 + cols.length * COL_W + (cols.length - 1) * GUTTER;
  const maxColH = Math.max(...cols.map((c) => c.colHeight));
  const totalH = MARGIN * 2 + maxColH;

  const composites = cols.map((c, i) => {
    const left = MARGIN + i * (COL_W + GUTTER);
    return [
      { input: c.labelBuf, left, top: MARGIN },
      { input: c.imgBuf, left, top: MARGIN + LABEL_H },
    ];
  }).flat();

  return sharp({
    create: { width: totalW, height: totalH, channels: 3, background: { r: 248, g: 250, b: 252 } },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

// ---- Helpers ----------------------------------------------------------------

/// Extract {"direction", "spec"} from a model response — strips fences,
/// finds the first balanced {...}, validates the spec is an object.
export function extractSpecJson(content: string): Record<string, unknown> | null {
  // Fast path: the whole (fence-stripped) response is one JSON value —
  // handles array-root responses that first-balanced-block extraction
  // would mis-slice (it finds the first '{' INSIDE the array).
  const whole = tryParseWhole(content);
  if (whole !== null) {
    if (whole.spec && typeof whole.spec === 'object' && !Array.isArray(whole.spec)) {
      return coerceNodeTree(whole.spec) ?? null;
    }
    return coerceNodeTree(whole);
  }
  const obj = extractJsonBlock(content);
  if (!obj) return null;
  if (obj.spec && typeof obj.spec === 'object' && !Array.isArray(obj.spec)) {
    return coerceNodeTree(obj.spec) ?? null;
  }
  // Some models emit the spec root directly (no wrapper).
  return coerceNodeTree(obj);
}

/// Fence-tolerant whole-content JSON.parse. null when not pure JSON.
function tryParseWhole(content: string): any | null {
  let s = content.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  if (!s.startsWith('{') && !s.startsWith('[')) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/// Coerce near-miss model schemas into the node-tree contract:
///   1. Root is a node (type/children) — passthrough.
///   2. Root is an ARRAY of nodes — wrap in a frame.
///   3. Root holds a components-ish array (ui_components/components/
///      sections/elements) whose items are node-shaped — wrap in a frame.
///   4. Node "layout"/"positioning" descriptor objects are dropped
///      (unmappable) — the tree still renders without them.
/// Returns null when nothing node-shaped can be salvaged.
function coerceNodeTree(obj: any): Record<string, unknown> | null {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    const kids = obj.filter(isNodeShaped);
    return kids.length > 0 ? { type: 'frame', name: 'Variant', children: kids } : null;
  }
  if (typeof obj.type === 'string' || Array.isArray(obj.children)) {
    return stripDescriptorFields(obj) as Record<string, unknown>;
  }
  // Components-ish container keys.
  const CONTAINER_KEYS = ['ui_components', 'components', 'sections', 'elements', 'nodes'];
  for (const key of CONTAINER_KEYS) {
    const arr = obj[key];
    if (Array.isArray(arr)) {
      const kids = arr.filter(isNodeShaped);
      if (kids.length > 0) {
        return {
          type: 'frame',
          name: typeof obj.name === 'string' ? obj.name : 'Variant',
          children: kids.map(stripDescriptorFields),
        };
      }
    }
  }
  return null;
}

/// Does this object look like a spec node (has a known type or children)?
function isNodeShaped(v: any): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  if (typeof v.type === 'string') return true;
  return Array.isArray(v.children);
}

/// Remove model-invented descriptor keys that have no node-tree meaning,
/// and normalize invented type names ("navbar", "card", "button") to the
/// real node vocabulary (frame) so the resolver never sees unknown types.
const DESCRIPTOR_KEYS = new Set(['layout', 'positioning', 'max_width', 'content', 'variant', 'metadata', 'description']);
const KNOWN_TYPES = new Set(['frame', 'rectangle', 'ellipse', 'text', 'line', 'group', 'icon']);
function stripDescriptorFields(node: any): any {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (DESCRIPTOR_KEYS.has(k)) continue;
    if (k === 'children' && Array.isArray(v)) {
      out.children = v.filter(isNodeShaped).map(stripDescriptorFields);
    } else {
      out[k] = v;
    }
  }
  if (typeof out.type === 'string' && !KNOWN_TYPES.has(out.type)) {
    // Invented type ("navbar", "card") — degrade to frame so it renders.
    out.type = 'frame';
  }
  return out;
}

/// First balanced {...} block in the string, JSON.parsed. Fence-tolerant.
export function extractJsonBlock(content: string): any | null {
  let s = content.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  }
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
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

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case "'": return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}
