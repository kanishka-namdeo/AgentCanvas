// scenarios.ts — Prompt-vs-output eval scenarios for the AgentCanvas agent.
//
// Each scenario defines:
//   id            stable slug (used in reports + screenshots)
//   prompt        exactly what we send to /api/agent
//   seed          optional initial canvas (CanvasDocument) the turn starts from
//   assertions    named checks over (finalCanvas, trajectory) → pass/fail + detail
//
// Assertion philosophy (informed by agent-eval best practice):
//   - Deterministic structural checks (layer counts/types/attrs) — no flaky
//     pixel-diffing.
//   - Trajectory checks (tool errors, duplicate calls, runaway loops).
//   - Fidelity-policy checks (hi-fi asks get color+shadow+real copy;
//     wireframe asks stay grayscale+flat).

import type { CanvasDocument, Layer } from '../../src/lib/canvas/types';
import { createEmptyCanvasDocument } from '../../src/lib/canvas/types';
import { applyPatchToCanvas } from '../../src/lib/canvas/patch';

// ---- trajectory summary passed to every assertion ---------------------------

export interface Trajectory {
  toolCalls: Array<{ name: string; success: boolean; summary: string; argsPreview: string }>;
  errors: string[];
  messageText: string;
  durationMs: number;
}

export interface AssertionResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface Scenario {
  id: string;
  prompt: string;
  seed?: CanvasDocument;
  visual?: boolean; // capture a browser screenshot for this scenario
  /// HELD-OUT scenarios are NEVER iterated against during development — they
  /// exist to measure generalization, not convergence. run-eval.ts EXCLUDES
  /// them by default (dev runs: 6/8-style iteration can't touch them) and
  /// includes them only under --include-heldout (final validation). Once a
  /// held-out scenario has been used to grade a change, it is burned — write
  /// a new one for the next measurement (teaching-to-the-test firewall).
  heldOut?: boolean;
  assertions: Array<(canvas: CanvasDocument, t: Trajectory) => AssertionResult>;
}

// ---- color helpers ----------------------------------------------------------

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec((hex || '').trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/// 0 = fully saturated, 1 = gray. max(r,g,b)==0 → gray.
/// Non-hex values ('transparent', 'var(--x)', gradients refs) count as
/// NOT saturated — they carry no chroma. (Harness bug fix: this previously
/// returned 1 for unparsable colors, so 'transparent' fills were counted as
/// "saturated layers" and failed the lo-fi grayscale check.)
function saturation(hex: string): number {
  const c = hexToRgb(hex);
  if (!c) return 0;
  const mx = Math.max(c.r, c.g, c.b);
  const mn = Math.min(c.r, c.g, c.b);
  if (mx === 0) return 1;
  return (mx - mn) / mx;
}

function hueOf(hex: string): number | null {
  const c = hexToRgb(hex);
  if (!c) return null;
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx === mn) return null; // achromatic
  const d = mx - mn;
  let h: number;
  if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return Math.round(h * 60);
}

const inHueRange = (hex: string, lo: number, hi: number, minSat = 0.25) => {
  const h = hueOf(hex);
  return h !== null && saturation(hex) >= minSat && (lo <= hi ? h >= lo && h <= hi : h >= lo || h <= hi);
};

const isReddish = (hex: string) => inHueRange(hex, 335, 360) || inHueRange(hex, 0, 20);
const isGreenish = (hex: string) => inHueRange(hex, 70, 170);
const isBluish = (hex: string) => inHueRange(hex, 190, 260);

// ---- generic layer helpers --------------------------------------------------

const layers = (c: CanvasDocument) => c.shapes ?? [];
const visible = (c: CanvasDocument) => layers(c).filter((l) => l.visible !== false);
const ofTypes = (c: CanvasDocument, types: string[]) => visible(c).filter((l) => types.includes(l.type));
const texts = (c: CanvasDocument) => ofTypes(c, ['text']);
const textContent = (c: CanvasDocument) => texts(c).map((t) => t.text ?? '').join(' \n ');

const ok = (name: string, detail: string): AssertionResult => ({ name, pass: true, detail });
const fail = (name: string, detail: string): AssertionResult => ({ name, pass: false, detail });

function assert(name: string, cond: boolean, passDetail: string, failDetail: string): AssertionResult {
  return cond ? ok(name, passDetail) : fail(name, failDetail);
}

/// Trajectory invariants shared by every scenario.
function trajectoryChecks(minTools: number): Array<(c: CanvasDocument, t: Trajectory) => AssertionResult> {
  return [
    (_c, t) => {
      const failed = t.toolCalls.filter((tc) => !tc.success);
      return assert(
        'no failed tool calls',
        failed.length === 0,
        `all ${t.toolCalls.length} tool calls succeeded`,
        // Task 7-b: 200 chars — at 60 the summary was amputated exactly after
        // the bullet dash ("…\":\n  - "), so validation errors looked EMPTY in
        // reports even though the model-facing message had path + reason.
        `${failed.length} failed: ${failed.map((f) => `${f.name} (${f.summary.slice(0, 200)})`).join('; ')}`,
      );
    },
    (_c, t) => {
      // Duplicate consecutive identical calls = wasted iterations (classic
      // agent loop pathology). Same name AND same argsPreview twice in a row.
      let dup = 0;
      for (let i = 1; i < t.toolCalls.length; i++) {
        const a = t.toolCalls[i - 1], b = t.toolCalls[i];
        if (a.name === b.name && a.argsPreview === b.argsPreview) dup++;
      }
      return assert('no duplicate consecutive calls', dup === 0, 'no repeated identical calls', `${dup} repeated identical call(s) in a row`);
    },
    (_c, t) => {
      // A turn that does near-zero tool calls for a build request is a refusal
      // or chat-only answer. A turn with a huge number is a runaway loop.
      // Round 3 (task 10-d): generative/macro tools (pen_generate_*,
      // pen_insert_html, pen_create_subtree) can legitimately build an entire
      // screen in ONE call — round2-kimi one-shotted a 60-layer dashboard via
      // a single pen_generate_variants — so when any macro tool appears in the
      // trajectory the minimum floor drops to 1. The max bound (runaway-loop
      // guard) is unchanged.
      const n = t.toolCalls.length;
      const macroTools = [
        ...new Set(
          t.toolCalls
            .map((tc) => tc.name)
            .filter((name) => name.startsWith('pen_generate_') || name === 'pen_insert_html' || name === 'pen_create_subtree'),
        ),
      ];
      const macroUsed = macroTools.length > 0;
      const floor = macroUsed ? 1 : minTools;
      return assert(
        'reasonable tool-call count',
        n >= floor && n <= 90,
        `${n} tool calls${macroUsed && n < minTools ? ` (macro-tool exception applied: ${macroTools.join(', ')})` : ''}`,
        `${n} tool calls (expected ${floor}..90)${macroUsed ? ` — macro-tool exception applied (floor lowered to 1; saw ${macroTools.join(', ')})` : ''}`,
      );
    },
    (_c, t) => assert('no agent errors', t.errors.length === 0, 'clean turn', `errors: ${t.errors.join(' | ').slice(0, 200)}`),
  ];
}

// ---- fidelity helpers -------------------------------------------------------

/// Non-grayscale fill present on at least `n` visible layers.
function colorfulLayers(c: CanvasDocument, n: number): boolean {
  return visible(c).filter((l) => saturation(l.fill) >= 0.3).length >= n;
}

function anyShadow(c: CanvasDocument): boolean {
  return visible(c).some((l) => l.shadow && (l.shadow.blur > 0 || l.shadow.y > 0));
}

function anyGradient(c: CanvasDocument): boolean {
  return visible(c).some((l) => l.gradient && l.gradient.stops?.length >= 2);
}

const PLACEHOLDER_RE = /lorem ipsum|item \d|^label$|placeholder text|untitled|foo bar|example text/i;

function placeholderTexts(c: CanvasDocument): string[] {
  return texts(c).map((t) => (t.text ?? '').trim()).filter((s) => s.length > 0 && PLACEHOLDER_RE.test(s));
}

/// Seed: canvas with 3 layers, used by modify-precision scenarios.
/// Built through the REAL patch pipeline (applyPatchToCanvas) so the .pen
/// `children` tree is populated — normalizeCanvas derives `shapes` from the
/// tree, and a shapes-only seed reaches the agent as an EMPTY canvas (the
/// agent then can't find the layer to modify and may clear the canvas).
function seedThreeLayers(): CanvasDocument {
  let doc = createEmptyCanvasDocument('eval-modify', 'Modify eval');
  const seeds: Array<Partial<Layer> & { id: string }> = [
    { id: 'rect-banner', type: 'rectangle', name: 'Banner', x: 80, y: 80, width: 320, height: 120, fill: '#3b82f6', radius: 8 },
    { id: 'dot-status', type: 'ellipse', name: 'Status Dot', x: 440, y: 80, width: 48, height: 48, fill: '#ef4444' },
    { id: 'txt-note', type: 'text', name: 'Note', x: 80, y: 240, width: 260, height: 24, text: 'Existing note — do not touch', fontSize: 16 },
  ];
  for (const s of seeds) {
    doc = applyPatchToCanvas(doc, {
      op: 'add',
      shapeId: s.id,
      shape: s as Partial<Layer> & Record<string, unknown>,
      summary: `seed ${s.name}`,
    });
  }
  return doc;
}

// ---- the scenarios ----------------------------------------------------------

export const SCENARIOS: Scenario[] = [
  {
    id: 'simple-shape',
    prompt: 'Draw a red rounded rectangle, 240x120, in the top-left area of the canvas.',
    assertions: [
      (c) => {
        const rects = ofTypes(c, ['rectangle', 'frame']).filter((r) => r.width >= 180 && r.width <= 320 && r.height >= 80 && r.height <= 180);
        return assert('rectangle near 240x120 exists', rects.length >= 1, `${rects.length} match(es)`, 'no rectangle in the 180..320 x 80..180 size range');
      },
      (c) => {
        const red = visible(c).filter((l) => l.type === 'rectangle' && isReddish(l.fill));
        return assert('fill is red', red.length >= 1, `found ${red.map((r) => r.fill).join(', ')}`, 'no rectangle with a red-hue fill');
      },
      (c) => {
        const rounded = ofTypes(c, ['rectangle']).filter((r) => r.radius >= 4);
        return assert('corners rounded', rounded.length >= 1, `radius=${rounded[0]?.radius}`, 'no rectangle with radius >= 4');
      },
      (c) => assert(
        'placed top-left (x<600, y<400)',
        visible(c).some((l) => l.x < 600 && l.y < 400),
        'position ok',
        'no layer in the top-left quadrant',
      ),
      ...trajectoryChecks(1),
    ],
  },

  {
    id: 'text-heading',
    prompt: "Add a bold heading that says 'Quarterly Report' at 32px, centered near the top of the canvas.",
    assertions: [
      (c) => {
        const t = texts(c).find((x) => (x.text ?? '').toLowerCase().includes('quarterly report'));
        return assert('heading text present', !!t, t?.text ?? '', 'no text layer containing "Quarterly Report"');
      },
      (c) => {
        const t = texts(c).find((x) => (x.text ?? '').toLowerCase().includes('quarterly report'));
        const fs = t?.fontSize ?? 0;
        return assert('fontSize ~32', fs >= 28 && fs <= 38, `${fs}px`, `${fs}px (expected 28..38)`);
      },
      (c) => assert('near top (y < 300)', texts(c).some((t) => t.y < 300), 'y ok', 'heading placed below y=300'),
      ...trajectoryChecks(1),
    ],
  },

  {
    id: 'login-hifi',
    prompt: "Design a polished, high-fidelity mobile login screen for a fintech app called 'Vaultly' with an email field, a password field, and a Sign In button.",
    visual: true,
    assertions: [
      (c) => assert('canvas has layers', visible(c).length >= 8, `${visible(c).length} layers`, `only ${visible(c).length} layers — too few for a login screen`),
      (c) => {
        const hasContainer = ofTypes(c, ['frame', 'group', 'section', 'component']).length >= 1;
        return assert('uses a container/frame', hasContainer, `${ofTypes(c, ['frame', 'group', 'section', 'component']).length} container(s)`, 'no frame/group — flat layer soup');
      },
      (c) => {
        const tc = textContent(c).toLowerCase();
        const hasEmail = tc.includes('email');
        const hasPass = tc.includes('password');
        return assert('email + password copy present', hasEmail && hasPass, `email=${hasEmail} password=${hasPass}`, `email=${hasEmail} password=${hasPass}`);
      },
      (c) => {
        const tc = textContent(c).toLowerCase();
        return assert('brand "Vaultly" present', tc.includes('vaultly'), 'brand copy ok', 'no "Vaultly" text anywhere');
      },
      (c) => assert('colorful design (hi-fi)', colorfulLayers(c, 3), '3+ saturated layers', 'fewer than 3 saturated-color layers — looks grayscale'),
      (c) => assert('shadows on elevated surfaces', anyShadow(c), 'shadow present', 'no shadow anywhere — flat/wireframe look'),
      (c) => assert('realistic copy (no placeholders)', placeholderTexts(c).length === 0, 'no placeholder text', `placeholders: ${placeholderTexts(c).slice(0, 3).join(', ')}`),
      (c) => {
        const tc = textContent(c).toLowerCase();
        return assert('Sign In action present', tc.includes('sign in'), 'CTA copy ok', 'no "Sign In" text');
      },
      ...trajectoryChecks(4),
    ],
  },

  {
    id: 'wireframe-lofi',
    prompt: 'Draw a low-fidelity wireframe of a blog homepage: header with nav, one hero article block, and a 3-card article grid.',
    visual: true,
    assertions: [
      (c) => assert('canvas has layers', visible(c).length >= 8, `${visible(c).length} layers`, `only ${visible(c).length} layers`),
      (c) => {
        // 3-card grid: at least 3 sibling-ish rects/frames of similar size
        const boxes = ofTypes(c, ['rectangle', 'frame']).filter((b) => b.width >= 100 && b.height >= 60);
        const heights = new Map<number, number>();
        for (const b of boxes) {
          const band = Math.round(b.height / 20) * 20;
          heights.set(band, (heights.get(band) ?? 0) + 1);
        }
        const hasGrid = [...heights.values()].some((n) => n >= 3);
        return assert('3-card grid present', hasGrid, `${boxes.length} boxes, size-bands=${JSON.stringify([...heights])}`, 'no 3+ boxes sharing a similar height band');
      },
      (c) => {
        const saturated = visible(c).filter((l) => saturation(l.fill) >= 0.3);
        return assert(
          'stays grayscale (lo-fi)',
          saturated.length <= 1,
          `${saturated.length} saturated layer(s) (tolerance 1)`,
          `${saturated.length} saturated layers: ${saturated.slice(0, 3).map((l) => `${l.name}:${l.fill}`).join(', ')} — wireframe should be grayscale`,
        );
      },
      (c) => assert('no shadows (lo-fi)', !anyShadow(c), 'flat as expected', 'shadows present in a wireframe request'),
      (c) => assert('no gradients (lo-fi)', !anyGradient(c), 'no gradients as expected', 'gradient present in a wireframe request'),
      // NOTE: min tools = 1 — pen_generate_wireframe can legitimately scaffold
      // the whole blog layout in one call; the structural assertions above are
      // the real bar.
      ...trajectoryChecks(1),
    ],
  },

  {
    id: 'modify-precision',
    prompt: 'Change the Banner rectangle fill to green. Leave everything else exactly as it is.',
    seed: seedThreeLayers(),
    assertions: [
      (c) => {
        const rect = c.shapes.find((l) => l.id === 'rect-banner') ?? visible(c).find((l) => l.type === 'rectangle');
        if (!rect) return fail('banner recolored green', 'rectangle not found');
        return assert('banner recolored green', isGreenish(rect.fill), rect.fill, `fill=${rect.fill} is not green-hued`);
      },
      (c) => {
        const dot = c.shapes.find((l) => l.id === 'dot-status');
        if (!dot) return fail('status dot untouched', 'ellipse not found (may have been deleted/rebuilt)');
        return assert('status dot untouched', dot.fill === '#ef4444', `fill=${dot.fill}`, `dot changed: ${dot.fill} (was #ef4444) — agent rebuilt instead of targeted update`);
      },
      (c) => {
        const note = c.shapes.find((l) => l.id === 'txt-note');
        if (!note) return fail('note text untouched', 'text layer not found');
        return assert(
          'note text untouched',
          (note.text ?? '').includes('Existing note') && note.y === 240,
          'unchanged',
          `note changed: text="${note.text?.slice(0, 30)}" y=${note.y} (was "Existing note — do not touch", y=240)`,
        );
      },
      (c) => assert(
        'no extra layers added',
        visible(c).length === 3,
        `still 3 layers`,
        `${visible(c).length} layers after a recolor request (expected 3) — agent over-built`,
      ),
      (c, t) => {
        const updates = t.toolCalls.filter((tc) => /update|set_fill|fill|style/i.test(tc.name)).length;
        return assert('used update-style tools', updates >= 1, `${updates} update call(s)`, 'no update/set_fill tool used');
      },
      ...trajectoryChecks(1),
    ],
  },

  {
    id: 'flowchart',
    prompt: 'Create a flowchart for a document approval process with 4 nodes: Start, Review, Approve, End — connected with arrows.',
    visual: true,
    assertions: [
      (c) => {
        const nodes = ofTypes(c, ['rectangle', 'ellipse', 'frame']);
        return assert('4+ node shapes', nodes.length >= 4, `${nodes.length} node shapes`, `only ${nodes.length} node shapes`);
      },
      (c) => {
        const tc = textContent(c).toLowerCase();
        const wanted = ['start', 'review', 'approve', 'end'];
        const missing = wanted.filter((w) => !tc.includes(w));
        return assert('all 4 node labels present', missing.length === 0, 'start/review/approve/end all present', `missing labels: ${missing.join(', ')}`);
      },
      (c) => {
        const lines = ofTypes(c, ['line', 'path']);
        return assert('connector lines present', lines.length >= 3, `${lines.length} line/path connectors`, `only ${lines.length} line/path layers — no arrows`);
      },
      // min tools = 2 — pen_generate_diagram can scaffold the flowchart in one
      // call plus a labeling pass; structural assertions are the real bar.
      ...trajectoryChecks(2),
    ],
  },

  {
    id: 'dashboard-hifi',
    prompt: "Design a high-fidelity analytics dashboard header bar plus a row of 4 KPI stat cards showing Revenue $128.4K, Active Users 8,421, Churn 2.1%, and NPS 62.",
    visual: true,
    assertions: [
      (c) => {
        const tc = textContent(c);
        const wanted = ['128.4', '8,421', '2.1', '62'];
        const missing = wanted.filter((w) => !tc.includes(w));
        return assert('all 4 KPI values present', missing.length === 0, 'all values found', `missing values: ${missing.join(', ')}`);
      },
      (c) => {
        // 4 card-like containers: frames/rects of similar height in a horizontal spread
        const cards = ofTypes(c, ['frame', 'rectangle', 'component']).filter((b) => b.width >= 120 && b.width <= 420 && b.height >= 60 && b.height <= 260);
        const bands = new Map<number, number>();
        for (const b of cards) {
          const band = Math.round(b.height / 24) * 24;
          bands.set(band, (bands.get(band) ?? 0) + 1);
        }
        const hasRow = [...bands.entries()].some(([, n]) => n >= 4);
        return assert('4 card-like containers in a row', hasRow, `${cards.length} candidates, bands=${JSON.stringify([...bands])}`, 'no 4 similar-height containers — cards not built');
      },
      (c) => assert('colorful (hi-fi)', colorfulLayers(c, 3), '3+ saturated layers', 'too grayscale for a hi-fi dashboard'),
      (c) => assert('shadows on cards', anyShadow(c), 'shadow present', 'no shadows — flat look'),
      (c) => assert('realistic copy (no placeholders)', placeholderTexts(c).length === 0, 'no placeholder text', `placeholders: ${placeholderTexts(c).slice(0, 3).join(', ')}`),
      ...trajectoryChecks(4),
    ],
  },

  {
    id: 'palette-sunset',
    prompt: "Generate a row of 5 color palette swatches for a 'Sunset' theme, each swatch labeled with its hex code.",
    assertions: [
      (c) => {
        const swatches = visible(c).filter((l) => ['rectangle', 'frame', 'ellipse'].includes(l.type) && saturation(l.fill) >= 0.2);
        return assert('5 saturated swatches', swatches.length >= 5, `${swatches.length} swatch layers`, `only ${swatches.length} saturated swatch layers`);
      },
      (c) => {
        const labels = texts(c).filter((t) => /#([0-9a-f]{6}|[0-9a-f]{3})/i.test(t.text ?? ''));
        return assert('hex code labels present', labels.length >= 5, `${labels.length} hex labels`, `only ${labels.length} text layers contain hex codes`);
      },
      (c) => {
        // sunset = warm hues: reds/oranges/pinks/purples dominate
        const swatches = visible(c).filter((l) => ['rectangle', 'frame', 'ellipse'].includes(l.type) && saturation(l.fill) >= 0.2);
        const warm = swatches.filter((l) => {
          const h = hueOf(l.fill);
          return h !== null && (h >= 300 || h <= 60); // pink/red/orange/yellow
        });
        return assert('warm sunset hues', warm.length >= Math.ceil(swatches.length / 2), `${warm.length}/${swatches.length} warm`, `only ${warm.length}/${swatches.length} warm-hued — doesn't read as sunset`);
      },
      ...trajectoryChecks(3),
    ],
  },

  // ---- HELD-OUT scenarios (generalization measurement — see Scenario.heldOut) --
  //
  // These prompts were written AFTER the dev suite converged and are never
  // used for iteration. They exercise structural patterns adjacent to (but
  // distinct from) the dev scenarios: a pricing card row (near: dashboard KPI
  // row), a settings form (near: login form), and a kanban board (near:
  // wireframe grid) — so a pass means the agent generalizes, not that it
  // memorized the dev fixtures.

  {
    id: 'pricing-cards',
    heldOut: true,
    prompt: "Design a pricing section with 3 plan cards side by side: Starter at $9/mo, Pro at $29/mo highlighted as 'Most Popular', and Enterprise at $99/mo. Each card lists at least 3 features.",
    assertions: [
      (c) => {
        // 3 similar-width card containers sharing a height band (pattern:
        // dashboard-hifi's 4-card row, but the model has never seen THIS ask).
        const cards = ofTypes(c, ['frame', 'rectangle', 'component']).filter((b) => b.width >= 140 && b.width <= 480 && b.height >= 160 && b.height <= 640);
        const bands = new Map<number, number>();
        for (const b of cards) {
          const band = Math.round(b.height / 40) * 40;
          bands.set(band, (bands.get(band) ?? 0) + 1);
        }
        const hasRow = [...bands.values()].some((n) => n >= 3);
        return assert('3 similar-height plan cards', hasRow, `${cards.length} candidates, bands=${JSON.stringify([...bands])}`, 'no 3 similar-height containers — pricing cards not built');
      },
      (c) => {
        // Prices: '$9' must be standalone (not a substring of $29/$99);
        // '29' and '99' are unambiguous enough as substrings.
        const tc = textContent(c);
        const hasNine = /\$\s*9(?![0-9])/.test(tc) || /\b9\s*\/\s*mo/i.test(tc);
        const missing = [
          ...(!hasNine ? ['standalone $9'] : []),
          ...(!tc.includes('29') ? ['$29'] : []),
          ...(!tc.includes('99') ? ['$99'] : []),
        ];
        return assert('all 3 prices present', missing.length === 0, 'all prices found', `missing: ${missing.join(', ')}`);
      },
      (c) => {
        const tc = textContent(c).toLowerCase();
        const wanted = ['starter', 'pro', 'enterprise'];
        const missing = wanted.filter((w) => !tc.includes(w));
        return assert('3 plan names present', missing.length === 0, 'starter/pro/enterprise found', `missing: ${missing.join(', ')}`);
      },
      (c) => assert("'Most Popular' highlight present", textContent(c).toLowerCase().includes('most popular'), 'highlight copy ok', 'no "Most Popular" text on the Pro card'),
      (c) => assert('colorful (hi-fi)', colorfulLayers(c, 3), '3+ saturated layers', 'too grayscale for a hi-fi pricing section'),
      (c) => assert('shadows on cards', anyShadow(c), 'shadow present', 'no shadows — flat look'),
      (c) => assert('realistic copy (no placeholders)', placeholderTexts(c).length === 0, 'no placeholder text', `placeholders: ${placeholderTexts(c).slice(0, 3).join(', ')}`),
      ...trajectoryChecks(3),
    ],
  },

  {
    id: 'profile-settings',
    heldOut: true,
    prompt: "Design an account settings panel: a round avatar, the name 'Ada Lovelace', an email field showing ada@example.org, a timezone selector, and Save and Cancel buttons.",
    assertions: [
      (c) => assert('round avatar present', ofTypes(c, ['ellipse']).some((e) => e.width >= 40 && e.height >= 40), 'ellipse avatar found', 'no ellipse >= 40px — avatar missing'),
      (c) => {
        const tc = textContent(c).toLowerCase();
        return assert("name 'Ada Lovelace' present", tc.includes('ada lovelace'), 'name found', 'no "Ada Lovelace" text');
      },
      (c) => {
        const tc = textContent(c).toLowerCase();
        return assert('email shown', tc.includes('ada@example.org') || tc.includes('ada@example'), 'email found', 'no ada@example.org text');
      },
      (c) => {
        const tc = textContent(c).toLowerCase();
        const hasSave = tc.includes('save');
        const hasCancel = tc.includes('cancel');
        return assert('Save + Cancel actions present', hasSave && hasCancel, `save=${hasSave} cancel=${hasCancel}`, `save=${hasSave} cancel=${hasCancel}`);
      },
      (c) => {
        const tc = textContent(c).toLowerCase();
        return assert('timezone selector present', tc.includes('timezone') || tc.includes('gmt') || tc.includes('utc'), 'timezone copy found', 'no timezone/GMT/UTC text');
      },
      (c) => {
        const hasContainer = ofTypes(c, ['frame', 'group', 'section', 'component']).length >= 1;
        return assert('uses a container/frame', hasContainer, `${ofTypes(c, ['frame', 'group', 'section', 'component']).length} container(s)`, 'no frame/group — flat layer soup');
      },
      (c) => assert('realistic copy (no placeholders)', placeholderTexts(c).length === 0, 'no placeholder text', `placeholders: ${placeholderTexts(c).slice(0, 3).join(', ')}`),
      ...trajectoryChecks(3),
    ],
  },

  {
    id: 'kanban-board',
    heldOut: true,
    prompt: 'Create a kanban board with three columns — To Do, In Progress, Done — each column with a header and two task cards with realistic task titles.',
    assertions: [
      (c) => {
        // 3 columns: tall containers sharing a similar WIDTH band.
        const cols = ofTypes(c, ['frame', 'rectangle', 'component']).filter((b) => b.width >= 140 && b.width <= 480 && b.height >= 240);
        const bands = new Map<number, number>();
        for (const b of cols) {
          const band = Math.round(b.width / 60) * 60;
          bands.set(band, (bands.get(band) ?? 0) + 1);
        }
        const hasCols = [...bands.values()].some((n) => n >= 3);
        return assert('3 columns present', hasCols, `${cols.length} candidates, bands=${JSON.stringify([...bands])}`, 'no 3 similar-width tall containers — columns not built');
      },
      (c) => {
        const tc = textContent(c).toLowerCase();
        // 'To Do' may render as "to do" or "todo"; 'In Progress' and 'Done'
        // have no common alternates.
        const missing = ['to do|todo', 'in progress', 'done'].filter((w) => !w.split('|').some((alt) => tc.includes(alt)));
        return assert('column headers present', missing.length === 0, 'todo/in-progress/done found', `missing headers: ${missing.join(', ')}`);
      },
      (c) => {
        // 6 task cards: card-sized boxes (shorter than columns), same count
        // as the prompt asks (2 per column × 3).
        const cards = ofTypes(c, ['frame', 'rectangle', 'component']).filter((b) => b.width >= 80 && b.width <= 460 && b.height >= 40 && b.height <= 200);
        return assert('6 task cards', cards.length >= 6, `${cards.length} card-sized boxes`, `only ${cards.length} card-sized boxes — expected 6 (2 per column)`);
      },
      (c) => assert('canvas has layers', visible(c).length >= 10, `${visible(c).length} layers`, `only ${visible(c).length} layers — too few for a 3-column board`),
      (c) => assert('realistic copy (no placeholders)', placeholderTexts(c).length === 0, 'no placeholder text', `placeholders: ${placeholderTexts(c).slice(0, 3).join(', ')}`),
      ...trajectoryChecks(3),
    ],
  },
];
