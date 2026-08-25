// Pi Agent SDK custom tools for canvas manipulation.
//
// This file is the canonical "agent-usable" surface of the Figma-like app.
// Each tool is defined with `defineTool` from `@earendil-works/pi-coding-agent`
// (the real Pi Agent SDK), using TypeBox (`@sinclair/typebox`) for parameter
// schemas — exactly the pattern documented at
// https://pi.dev/docs/latest/sdk.
//
// === TOOL INVENTORY (research-driven) =====================================
//
// Core canvas ops (existing — renamed to Figma-canonical names in Phase 6,
// with the legacy names kept as aliases; see tool-aliases.ts / Appendix G §G.3):
//   pen_create_node, pen_update_node, pen_delete_nodes,
//   pen_get_metadata (supersedes pen_list_shapes), pen_clear,
//   pen_set_background, pen_select_nodes
//
// Extended scenarios (added based on /research/*.json findings):
//
//   1. Auto Layout (Figma Auto Layout — see figma_features.json)
//      - pen_apply_auto_layout
//
//   2. Components & Variants (Figma component system)
//      - pen_create_component
//      - pen_instantiate_component
//
//   3. Layer organization (Figma layers panel + AI plugins)
//      - pen_duplicate_nodes
//      - pen_group_shapes
//      - pen_ungroup_shapes
//      - pen_align_shapes
//      - pen_organize_layers
//
//   4. Design tokens / variables (Figma Variables + AI design systems)
//      - pen_update_tokens
//      - pen_apply_palette
//      - pen_generate_palette
//
//   5. Wireframe generation (Uizard / Galileo AI / Figma Make)
//      - pen_generate_wireframe
//
//   6. Multi-screen user flows (UX Pilot, Galileo AI)
//      - pen_generate_user_flow
//
//   7. Diagram / flowchart generation (Figma AI diagrams)
//      - pen_generate_diagram
//
//   8. REMOVED: Attention heatmap prediction (Uizard predictive heat map)
//      Dropped for .pen format purity — pen.dev has no analysis-overlay concept.
//
//   9. Copy / text generation (Figma AI placeholder content)
//      - pen_generate_copy
//
//  10. Design auditing (AI design-system audit — ai_design_scenarios.json)
//      - pen_audit_design
//
// The agent backend (see `src/lib/agent/runner.ts`) registers these tools
// with the LLM and invokes their `execute` when the LLM calls them.

import { Type, type Static } from '@sinclair/typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { CanvasPatch, Shape, ShapeType, AutoLayout, DesignTokens, ColorToken, TextStyleToken } from '../canvas/types';
import { parseHtmlFragment, htmlToPenTreeDetailed } from '../canvas/html-import';
import { serializeNodes } from '../canvas/serialize';
import { resolvePenTreeDetailed, type ResolvedTreeNode } from '../pen/resolve';
import type { PenChild } from '../pen/types';
import { emitEvent, hasSink } from './plugins/event-bus';
import {
  aliasToolEntries,
  deprecationNotice,
  normalizeAutoLayoutV3,
  normalizeToolParams,
  resolveToolName,
  type AliasToolLike,
} from './tool-aliases';
import {
  awaitClientResponse,
  getMeasuredBounds,
  ROUNDTRIP_DEFAULTS,
  type ComputedResult,
  type ScreenshotResult,
} from './client-roundtrip';

// ---- Tool execution context -------------------------------------------------
//
// `defineTool`'s `execute` signature is:
//   (toolCallId, params, signal, onUpdate, ctx) => Promise<AgentToolResult>
//
// The tools here need access to:
//   1. The current canvas state (to read shapes / find by id).
//   2. A patch sink — every mutation is recorded as a `CanvasPatch` so it
//      can be persisted, broadcast to viewers, and replayed.
//
// We don't want to rewire the SDK's call signature, so we attach these via
// a closure when the tools are constructed for a given session. The factory
// `createCanvasTools()` below returns an array of `ToolDefinition`s bound
// to a specific session context.

export interface CanvasToolContext {
  /// Read-only snapshot of the current canvas state. The runner refreshes
  /// this before each tool call so the agent always sees fresh data.
  getShapes: () => Shape[];
  /// Read-only snapshot of the current design tokens.
  getTokens: () => DesignTokens;
  /// Apply a patch (the tool's effect) and return the patched document.
  applyPatch: (patch: CanvasPatch) => CanvasPatch;
  /// Read-only snapshot of the full document (background, viewport, etc.).
  /// Used by export tools. Optional — the runner always provides it.
  getDocument?: () => import('../canvas/types').CanvasDocument;
}

// ---- Parameter schemas ------------------------------------------------------

const ShapeTypeSchema = Type.Union(
  [
    Type.Literal('rectangle'),
    Type.Literal('ellipse'),
    Type.Literal('text'),
    Type.Literal('line'),
    Type.Literal('frame'),
    Type.Literal('group'),
    Type.Literal('path'),
    Type.Literal('image'),
  ],
  { description: 'Shape kind' },
);

const ShapeInputSchema = Type.Object({
  type: Type.Optional(ShapeTypeSchema),
  name: Type.Optional(Type.String({ description: 'Layer name shown in the layers panel' })),
  x: Type.Optional(Type.Number({ description: 'Canvas-space X (top-left origin)' })),
  y: Type.Optional(Type.Number({ description: 'Canvas-space Y' })),
  width: Type.Optional(Type.Number({ description: 'Width in px' })),
  height: Type.Optional(Type.Number({ description: 'Height in px' })),
  rotation: Type.Optional(Type.Number({ description: 'Rotation in degrees' })),
  opacity: Type.Optional(Type.Number({ description: 'Opacity 0..1' })),
  fill: Type.Optional(Type.String({ description: 'Fill color hex, e.g. #ff0000' })),
  stroke: Type.Optional(Type.String({ description: 'Stroke color hex' })),
  strokeWidth: Type.Optional(Type.Number({ description: 'Stroke width in px' })),
  radius: Type.Optional(Type.Number({ description: 'Border radius in px (rectangle/frame)' })),
  text: Type.Optional(Type.String({ description: 'Text content (type=text only)' })),
  fontSize: Type.Optional(Type.Number({ description: 'Font size for text shapes' })),
  fontWeight: Type.Optional(Type.Number({ description: 'Font weight 100..900 (default 400). The system prompt asks for 400/500/600/700 — body 400, labels 500, section heads 600, page titles 700.' })),
  fontFamily: Type.Optional(Type.String({ description: 'Font family CSS string. Default "Inter, system-ui, sans-serif" (Inter is loaded via next/font). Pass e.g. "Inter" or "Geist" to override.' })),
  letterSpacing: Type.Optional(Type.Number({ description: 'Letter spacing in px (can be negative for tightening, e.g. -0.4 for headings).' })),
  lineHeight: Type.Optional(Type.Number({ description: 'Line height as a unitless ratio (e.g. 1.6 for body, 1.25 for headings).' })),
  textAlign: Type.Optional(Type.Union([Type.Literal('left'), Type.Literal('center'), Type.Literal('right'), Type.Literal('justify')], { description: 'Horizontal text alignment within the layer bounds. center for titles/buttons, right for numbers/dates, left for body.' })),
  underline: Type.Optional(Type.Boolean({ description: 'Underline decoration (links).' })),
  strikethrough: Type.Optional(Type.Boolean({ description: 'Strikethrough decoration.' })),
  textColor: Type.Optional(Type.String({ description: 'Text color hex' })),
  // Phase 5 extended fields:
  src: Type.Optional(Type.String({ description: 'Image source URL (data URL or remote) — type=image only' })),
  closed: Type.Optional(Type.Boolean({ description: 'For path shapes: close the path (fill it). Default false.' })),
  blur: Type.Optional(Type.Number({ description: 'Gaussian blur radius in px' })),
  // ---- High-fidelity extended fields (so the LLM can create polished shapes in one call) ----
  gradient: Type.Optional(Type.Object({
    type: Type.Union([Type.Literal('linear'), Type.Literal('radial')], { description: 'Gradient type' }),
    angle: Type.Optional(Type.Number({ description: 'Angle in degrees (linear). Default 90.' })),
    stops: Type.Array(Type.Object({
      offset: Type.Number({ description: '0..1' }),
      color: Type.String({ description: 'Hex color' }),
    }), { description: 'Color stops (min 2)' }),
  }, { description: 'Gradient fill (overrides solid fill). Use for hero areas, CTAs, logos.' })),
  shadow: Type.Optional(Type.Object({
    x: Type.Number({ description: 'X offset in px' }),
    y: Type.Number({ description: 'Y offset in px' }),
    blur: Type.Number({ description: 'Blur radius in px' }),
    color: Type.String({ description: 'Shadow color hex with alpha, e.g. #0000001a for 10% black' }),
    spread: Type.Optional(Type.Number({ description: 'Spread in px (default 0)' })),
    inset: Type.Optional(Type.Boolean({ description: 'Inset shadow (default false)' })),
  }, { description: 'Drop shadow. Use 0,4,6,#0000001a for cards; 0,2,4,#0000001a for buttons; 0,8,12,#00000033 for FABs.' })),
  radii: Type.Optional(Type.Object({
    topLeft: Type.Number({ description: 'Top-left radius in px' }),
    topRight: Type.Number({ description: 'Top-right radius in px' }),
    bottomRight: Type.Number({ description: 'Bottom-right radius in px' }),
    bottomLeft: Type.Number({ description: 'Bottom-left radius in px' }),
  }, { description: 'Per-corner border radii (overrides uniform radius). Use for toast cards, sheets.' })),
  autoLayout: Type.Optional(Type.Object({
    direction: Type.Optional(Type.Union([Type.Literal('horizontal'), Type.Literal('vertical')], { description: 'Layout direction (legacy spelling; v3: layoutMode)' })),
    gap: Type.Optional(Type.Number({ description: 'Gap between children in px (default 8). v3 alias: itemSpacing.' })),
    padding: Type.Optional(Type.Number({ description: 'Padding inside frame in px (default 16). v3 aliases: paddingLeft/Right/Top/Bottom (uniform during the window).' })),
    alignX: Type.Optional(Type.Union([Type.Literal('min'), Type.Literal('center'), Type.Literal('max')], { description: 'Horizontal alignment (default center)' })),
    alignY: Type.Optional(Type.Union([Type.Literal('min'), Type.Literal('center'), Type.Literal('max')], { description: 'Vertical alignment (default center)' })),
    // Figma v3 spellings (spec Phase 6 / G.3 row 1) — normalized to the legacy
    // fields above by normalizeToolParams before execute runs.
    layoutMode: Type.Optional(Type.Union([Type.Literal('VERTICAL'), Type.Literal('HORIZONTAL'), Type.Literal('NONE'), Type.Literal('GRID')], { description: 'v3: VERTICAL | HORIZONTAL | NONE' })),
    itemSpacing: Type.Optional(Type.Number({ description: 'v3: main-axis gap in px' })),
    paddingLeft: Type.Optional(Type.Number({ description: 'v3: left padding' })),
    paddingRight: Type.Optional(Type.Number({ description: 'v3: right padding' })),
    paddingTop: Type.Optional(Type.Number({ description: 'v3: top padding' })),
    paddingBottom: Type.Optional(Type.Number({ description: 'v3: bottom padding' })),
    primaryAxisAlignItems: Type.Optional(Type.Union([Type.Literal('MIN'), Type.Literal('CENTER'), Type.Literal('MAX'), Type.Literal('SPACE_BETWEEN'), Type.Literal('SPACE_AROUND')], { description: 'v3: primary-axis alignment' })),
    counterAxisAlignItems: Type.Optional(Type.Union([Type.Literal('MIN'), Type.Literal('CENTER'), Type.Literal('MAX')], { description: 'v3: counter-axis alignment' })),
  }, { description: 'Auto Layout (flexbox) for frames — accepts legacy {direction,gap,padding,alignX,alignY} or Figma v3 {layoutMode,itemSpacing,paddingLeft…,primaryAxisAlignItems,counterAxisAlignItems}. Prefer over manual x/y for contained UI.' })),
  parentId: Type.Optional(Type.String({ description: 'Parent frame/group ID. If omitted, the shape is a top-level layer. (Note: to MOVE an existing node into a frame, use pen_reparent_nodes instead.)' })),
});

/// LLMs occasionally pass a nested object param as a JSON STRING (observed
/// with GLM: `changes: "{\"fill\":\"#0ea5e9\"}"`). pi-ai's TypeBox
/// validation rejects that BEFORE the tool's execute() runs — the call fails,
/// the model retries identically (wasted round trips), then works around it.
/// Accept both forms at the schema level and normalize strings to objects
/// before use, so the tolerant fallbacks inside execute() actually get a
/// chance to run.
const LooseShapeInputSchema = Type.Union([ShapeInputSchema, Type.String()], {
  description: 'The fields to change, as an object (a JSON-encoded string is also accepted and parsed).',
});

function parseLooseShapeInput(
  value: Static<typeof LooseShapeInputSchema> | undefined,
): Static<typeof ShapeInputSchema> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as Static<typeof ShapeInputSchema>;
    } catch {
      return {} as Static<typeof ShapeInputSchema>;
    }
  }
  return (value ?? {}) as Static<typeof ShapeInputSchema>;
}

// ---- Helpers ----------------------------------------------------------------

/// Task 7-c P3.1 / T4 — design-token enforcement hint.
///
/// The system prompt's COMPONENT RECIPES now use $color.* token syntax
/// (e.g. fill:"$color.primary" instead of fill:"#0ea5e9"). When the AI
/// still passes a raw hex string to a color field, we accept it (don't
/// break tests + don't break the agent's tool call) but emit a one-shot
/// console hint so the developer sees that the AI is bypassing the token
/// system. The hint is throttled (only fires once per color per process)
/// so it doesn't spam the log.
///
/// We DON'T rewrite the value because:
///   1. The renderer resolves $color.* via the canvas's `variables` map
///      — if the AI passes raw hex, it renders fine.
///   2. Force-rewriting would break existing tests that pass raw hex.
///   3. The system prompt's RECIPES already use tokens; well-behaved turns
///      won't trip the hint.
const _hexTokenHintFired = new Set<string>();
function hintTokenSyntaxIfRawHex(field: string, value: unknown): void {
  if (typeof value !== 'string') return;
  // Strip leading # + alpha to get the 6-hex core, then look up in our map.
  const m = value.match(/^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/);
  if (!m) return;
  const hex = m[1].toLowerCase();
  const token = COMMON_HEX_TO_TOKEN[hex];
  if (!token) return; // unknown hex — likely a one-off; don't hint
  const key = `${field}:${hex}`;
  if (_hexTokenHintFired.has(key)) return;
  _hexTokenHintFired.add(key);
  console.warn(
    `[design-tokens] AI passed raw hex ${value} to ${field}. ` +
    `Consider using $${token} instead — define it via pen_set_variable and ` +
    `bind shapes to it for consistent, editable colors. ` +
    `(Component RECIPES in the system prompt now use $color.* syntax.)`,
  );
}

/// Map of common Tailwind/shadcn hex codes → $color.* token names.
/// Used by hintTokenSyntaxIfRawHex to suggest the token form.
/// These mirror the SEMANTIC COLOR TOKENS section in the system prompt.
///
/// NOTE: object keys MUST be quoted — bare hex-looking strings like `f0f9ff:`
/// parse as numeric literals (`0xf0f9ff`) + a label, which is a syntax error.
const COMMON_HEX_TO_TOKEN: Record<string, string> = {
  // Neutrals (slate ramp)
  'f8fafc': 'color.bg',
  'f1f5f9': 'color.surface-2',
  'e2e8f0': 'color.border',
  'cbd5e1': 'color.border-strong',
  '94a3b8': 'color.text-subtle',
  '64748b': 'color.text-muted',
  '475569': 'color.text-muted',
  '0f172a': 'color.text',
  // Sky ramp (default brand)
  'f0f9ff': 'color.primary-50',
  'e0f2fe': 'color.primary-100',
  'bae6fd': 'color.primary-200',
  '7dd3fc': 'color.primary-300',
  '38bdf8': 'color.primary-400',
  '0ea5e9': 'color.primary',
  '0284c7': 'color.primary-600',
  '0369a1': 'color.primary-700',
  '075985': 'color.primary-800',
  '0c4a6e': 'color.primary-900',
  // Indigo ramp (accent)
  'eef2ff': 'color.accent-50',
  'e0e7ff': 'color.accent-100',
  'c7d2fe': 'color.accent-200',
  'a5b4fc': 'color.accent-300',
  '818cf8': 'color.accent-400',
  '6366f1': 'color.accent',
  '4f46e5': 'color.accent-600',
  '4338ca': 'color.accent-700',
  '3730a3': 'color.accent-800',
  '312e81': 'color.accent-900',
  // Emerald (success)
  '10b981': 'color.success',
  '059669': 'color.success-600',
  // Rose (danger)
  'ef4444': 'color.danger',
  // Amber (warning)
  'f59e0b': 'color.warning',
  // White
  'ffffff': 'color.surface',
};

/// Coerce LLM-provided arguments into the types the schema expects.
/// LLMs sometimes pass numbers as strings (e.g. `x: "400"` instead of `400`).
/// This helper normalizes those before they reach the patch layer.
///
/// Task 7-c P3.1 / T4 — design-token enforcement:
/// When the AI passes a raw hex color (e.g. "#3b82f6") to `fill` / `stroke` /
/// `textColor`, we accept it (don't break tests) but emit a one-shot console
/// hint nudging the AI toward $color.* token syntax. The system prompt's
/// COMPONENT RECIPES now use $color.* exclusively, so well-behaved turns
/// won't trip the hint. Raw hex from the AI is a fallback, not the default.
function coerceShapeInput(params: Static<typeof ShapeInputSchema>): Partial<Shape> {
  const out: Partial<Shape> = {};
  if (params.type !== undefined) out.type = params.type as Shape['type'];
  if (params.name !== undefined) out.name = String(params.name);
  if (params.x !== undefined) out.x = Number(params.x) || 0;
  if (params.y !== undefined) out.y = Number(params.y) || 0;
  if (params.width !== undefined) out.width = Number(params.width) || 0;
  if (params.height !== undefined) out.height = Number(params.height) || 0;
  if (params.rotation !== undefined) out.rotation = Number(params.rotation) || 0;
  if (params.opacity !== undefined) out.opacity = Math.max(0, Math.min(1, Number(params.opacity) || 1));
  if (params.fill !== undefined) {
    out.fill = String(params.fill);
    hintTokenSyntaxIfRawHex('fill', params.fill);
  }
  if (params.stroke !== undefined) {
    out.stroke = String(params.stroke);
    hintTokenSyntaxIfRawHex('stroke', params.stroke);
  }
  if (params.strokeWidth !== undefined) out.strokeWidth = Number(params.strokeWidth) || 0;
  if (params.radius !== undefined) out.radius = Number(params.radius) || 0;
  if (params.text !== undefined) out.text = String(params.text);
  if (params.fontSize !== undefined) out.fontSize = Number(params.fontSize) || 16;
  if (params.textColor !== undefined) {
    out.textColor = String(params.textColor);
    hintTokenSyntaxIfRawHex('textColor', params.textColor);
  }
  // Typography fields (passed through to the .pen node via patch.ts and
  // applied by the SVG renderer). Without these, the system prompt's
  // weight/alignment instructions were silently dropped — the AI could
  // not actually specify a heading weight or a centered title.
  if ((params as any).fontWeight !== undefined) out.fontWeight = Number((params as any).fontWeight) || 400;
  if ((params as any).fontFamily !== undefined) out.fontFamily = String((params as any).fontFamily);
  if ((params as any).letterSpacing !== undefined) out.letterSpacing = Number((params as any).letterSpacing) || 0;
  if ((params as any).lineHeight !== undefined) out.lineHeight = Number((params as any).lineHeight) || 1.4;
  if ((params as any).textAlign !== undefined) out.textAlign = (params as any).textAlign;
  if ((params as any).underline !== undefined) out.underline = !!(params as any).underline;
  if ((params as any).strikethrough !== undefined) out.strikethrough = !!(params as any).strikethrough;
  // Phase 5 extended fields:
  if ((params as any).src !== undefined) out.src = String((params as any).src);
  if ((params as any).closed !== undefined) out.closed = !!(params as any).closed;
  if ((params as any).blur !== undefined) out.blur = Number((params as any).blur) || 0;
  if (Array.isArray((params as any).points)) {
    out.points = (params as any).points.map((p: any) => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }));
  }
  if ((params as any).radii) {
    const r = (params as any).radii;
    out.radii = {
      topLeft: Number(r.topLeft) || 0,
      topRight: Number(r.topRight) || 0,
      bottomRight: Number(r.bottomRight) || 0,
      bottomLeft: Number(r.bottomLeft) || 0,
    };
  }
  if ((params as any).gradient) {
    const g = (params as any).gradient;
    out.gradient = {
      type: g.type === 'radial' ? 'radial' : 'linear',
      angle: Number(g.angle) || 0,
      stops: Array.isArray(g.stops) ? g.stops.map((s: any) => ({ offset: Number(s.offset) || 0, color: String(s.color) })) : [],
    };
  }
  if ((params as any).shadow) {
    const sh = (params as any).shadow;
    out.shadow = {
      x: Number(sh.x) || 0,
      y: Number(sh.y) || 0,
      blur: Number(sh.blur) || 0,
      color: String(sh.color ?? '#000000'),
      spread: sh.spread !== undefined ? Number(sh.spread) : 0,
      inset: !!sh.inset,
    };
  }
  if ((params as any).maskId !== undefined) out.maskId = (params as any).maskId ? String((params as any).maskId) : null;
  if ((params as any).locked !== undefined) out.locked = !!(params as any).locked;
  if ((params as any).visible !== undefined) out.visible = (params as any).visible !== false;
  // High-fidelity extended fields:
  if ((params as any).autoLayout) {
    // Accept BOTH spellings (spec Phase 6 / G.3 row 1): legacy
    // {direction,gap,padding,alignX,alignY} and Figma v3
    // {layoutMode,itemSpacing,paddingLeft…,primaryAxisAlignItems,counterAxisAlignItems}.
    // normalizeToolParams folds v3→legacy at the execution boundary; this is
    // the safety net for direct execute calls.
    const al = normalizeAutoLayoutV3((params as any).autoLayout);
    out.autoLayout = {
      direction: al.direction === 'horizontal' ? 'horizontal' : 'vertical',
      gap: al.gap !== undefined ? Number(al.gap) : 8,
      padding: al.padding !== undefined ? Number(al.padding) : 16,
      alignX: ['min', 'center', 'max'].includes(al.alignX) ? al.alignX : 'center',
      alignY: ['min', 'center', 'max'].includes(al.alignY) ? al.alignY : 'center',
    };
  }
  if ((params as any).parentId !== undefined) out.parentId = (params as any).parentId ? String((params as any).parentId) : null;
  return out;
}

/// Convert HSL → hex. Used by the palette generator.
function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const v = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/// Parse a hex color → {h, s, l}.
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

/// Escape a string for safe inclusion in XML/SVG text content.
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/// Escape a string for use in a RegExp.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/// A curated subset of Lucide icon path data (24×24 viewBox).
/// Each icon is an array of {x, y} polyline points. These are simplified
/// approximations of the real Lucide icons — enough for placeholder use.
const LUCIDE_ICONS: Record<string, Array<{ x: number; y: number }>> = {
  check: [{ x: 20, y: 6 }, { x: 9, y: 17 }, { x: 4, y: 12 }],
  x: [{ x: 18, y: 6 }, { x: 6, y: 18 }, { x: 6, y: 6 }, { x: 18, y: 18 }],
  plus: [{ x: 12, y: 5 }, { x: 12, y: 19 }, { x: 5, y: 12 }, { x: 19, y: 12 }],
  minus: [{ x: 5, y: 12 }, { x: 19, y: 12 }],
  'arrow-right': [{ x: 5, y: 12 }, { x: 19, y: 12 }, { x: 12, y: 5 }, { x: 12, y: 19 }],
  'arrow-left': [{ x: 19, y: 12 }, { x: 5, y: 12 }, { x: 12, y: 19 }, { x: 12, y: 5 }],
  'arrow-up': [{ x: 12, y: 19 }, { x: 12, y: 5 }, { x: 5, y: 12 }, { x: 19, y: 12 }],
  'arrow-down': [{ x: 12, y: 5 }, { x: 12, y: 19 }, { x: 5, y: 12 }, { x: 19, y: 12 }],
  'chevron-down': [{ x: 6, y: 9 }, { x: 12, y: 15 }, { x: 18, y: 9 }],
  'chevron-up': [{ x: 18, y: 15 }, { x: 12, y: 9 }, { x: 6, y: 15 }],
  'chevron-left': [{ x: 15, y: 18 }, { x: 9, y: 12 }, { x: 15, y: 6 }],
  'chevron-right': [{ x: 9, y: 18 }, { x: 15, y: 12 }, { x: 9, y: 6 }],
  search: [{ x: 11, y: 11 }, { x: 21, y: 21 }, { x: 11, y: 11 }, { x: 11, y: 8 }, { x: 8, y: 8 }, { x: 8, y: 11 }, { x: 11, y: 11 }],
  settings: [{ x: 12, y: 12 }, { x: 12, y: 12 }, { x: 19, y: 12 }, { x: 19, y: 12 }, { x: 12, y: 5 }, { x: 12, y: 5 }, { x: 5, y: 12 }, { x: 5, y: 12 }],
  user: [{ x: 20, y: 21 }, { x: 20, y: 21 }, { x: 16, y: 16 }, { x: 12, y: 12 }, { x: 8, y: 16 }, { x: 4, y: 21 }, { x: 4, y: 21 }],
  heart: [{ x: 20, y: 8 }, { x: 20, y: 8 }, { x: 12, y: 8 }, { x: 4, y: 8 }, { x: 4, y: 8 }, { x: 12, y: 21 }, { x: 20, y: 8 }],
  star: [{ x: 12, y: 2 }, { x: 15, y: 8 }, { x: 22, y: 8 }, { x: 17, y: 13 }, { x: 19, y: 20 }, { x: 12, y: 16 }, { x: 5, y: 20 }, { x: 7, y: 13 }, { x: 2, y: 8 }, { x: 9, y: 8 }, { x: 12, y: 2 }],
  bell: [{ x: 18, y: 8 }, { x: 18, y: 8 }, { x: 6, y: 8 }, { x: 6, y: 8 }, { x: 6, y: 8 }, { x: 18, y: 8 }, { x: 16, y: 16 }, { x: 8, y: 16 }, { x: 18, y: 8 }, { x: 12, y: 2 }, { x: 6, y: 8 }],
  mail: [{ x: 4, y: 4 }, { x: 20, y: 4 }, { x: 20, y: 20 }, { x: 4, y: 20 }, { x: 4, y: 4 }, { x: 4, y: 4 }, { x: 12, y: 13 }, { x: 20, y: 4 }],
  phone: [{ x: 22, y: 16 }, { x: 22, y: 16 }, { x: 16, y: 16 }, { x: 13, y: 13 }, { x: 13, y: 13 }, { x: 11, y: 11 }, { x: 11, y: 11 }, { x: 8, y: 8 }, { x: 2, y: 8 }, { x: 2, y: 8 }],
  calendar: [{ x: 3, y: 4 }, { x: 21, y: 4 }, { x: 21, y: 20 }, { x: 3, y: 20 }, { x: 3, y: 4 }, { x: 3, y: 4 }, { x: 8, y: 2 }, { x: 8, y: 6 }, { x: 16, y: 2 }, { x: 16, y: 6 }],
  clock: [{ x: 12, y: 12 }, { x: 12, y: 12 }, { x: 12, y: 6 }, { x: 12, y: 6 }, { x: 12, y: 12 }, { x: 16, y: 12 }, { x: 12, y: 12 }],
  home: [{ x: 3, y: 12 }, { x: 12, y: 3 }, { x: 21, y: 12 }, { x: 5, y: 12 }, { x: 5, y: 21 }, { x: 19, y: 21 }, { x: 19, y: 12 }],
  menu: [{ x: 3, y: 6 }, { x: 21, y: 6 }, { x: 3, y: 12 }, { x: 21, y: 12 }, { x: 3, y: 18 }, { x: 21, y: 18 }],
  share: [{ x: 4, y: 12 }, { x: 4, y: 12 }, { x: 12, y: 20 }, { x: 12, y: 20 }, { x: 12, y: 20 }, { x: 20, y: 12 }, { x: 20, y: 12 }, { x: 12, y: 4 }, { x: 12, y: 4 }, { x: 12, y: 4 }, { x: 4, y: 12 }],
  download: [{ x: 12, y: 3 }, { x: 12, y: 15 }, { x: 7, y: 10 }, { x: 12, y: 15 }, { x: 17, y: 10 }, { x: 4, y: 21 }, { x: 20, y: 21 }],
  upload: [{ x: 12, y: 21 }, { x: 12, y: 9 }, { x: 7, y: 14 }, { x: 12, y: 9 }, { x: 17, y: 14 }, { x: 4, y: 3 }, { x: 20, y: 3 }],
  edit: [{ x: 12, y: 20 }, { x: 9, y: 20 }, { x: 9, y: 20 }, { x: 5, y: 16 }, { x: 5, y: 16 }, { x: 16, y: 5 }, { x: 16, y: 5 }, { x: 19, y: 8 }, { x: 19, y: 8 }, { x: 8, y: 19 }],
  trash: [{ x: 3, y: 6 }, { x: 21, y: 6 }, { x: 8, y: 6 }, { x: 8, y: 6 }, { x: 8, y: 6 }, { x: 16, y: 6 }, { x: 16, y: 6 }, { x: 19, y: 6 }, { x: 19, y: 6 }, { x: 18, y: 20 }, { x: 6, y: 20 }, { x: 6, y: 6 }],
  copy: [{ x: 9, y: 9 }, { x: 9, y: 9 }, { x: 9, y: 21 }, { x: 9, y: 21 }, { x: 9, y: 21 }, { x: 21, y: 21 }, { x: 21, y: 21 }, { x: 21, y: 9 }, { x: 21, y: 9 }, { x: 9, y: 9 }, { x: 9, y: 9 }, { x: 4, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 16 }],
  lock: [{ x: 5, y: 11 }, { x: 5, y: 11 }, { x: 19, y: 11 }, { x: 19, y: 11 }, { x: 19, y: 11 }, { x: 5, y: 11 }, { x: 5, y: 11 }, { x: 8, y: 11 }, { x: 8, y: 11 }, { x: 8, y: 7 }, { x: 8, y: 7 }, { x: 8, y: 7 }, { x: 16, y: 7 }, { x: 16, y: 7 }, { x: 16, y: 11 }],
  unlock: [{ x: 5, y: 11 }, { x: 5, y: 11 }, { x: 19, y: 11 }, { x: 19, y: 11 }, { x: 19, y: 11 }, { x: 5, y: 11 }, { x: 5, y: 11 }, { x: 8, y: 11 }, { x: 8, y: 11 }, { x: 8, y: 7 }, { x: 8, y: 7 }, { x: 8, y: 7 }, { x: 16, y: 7 }, { x: 16, y: 7 }, { x: 16, y: 4 }],
  eye: [{ x: 2, y: 12 }, { x: 12, y: 12 }, { x: 22, y: 12 }, { x: 12, y: 12 }, { x: 2, y: 12 }, { x: 12, y: 5 }, { x: 12, y: 5 }, { x: 19, y: 12 }, { x: 19, y: 12 }, { x: 12, y: 19 }, { x: 12, y: 19 }, { x: 5, y: 12 }],
  'eye-off': [{ x: 2, y: 2 }, { x: 2, y: 2 }, { x: 22, y: 22 }, { x: 9, y: 9 }, { x: 9, y: 9 }, { x: 15, y: 15 }, { x: 15, y: 15 }, { x: 2, y: 12 }, { x: 12, y: 12 }, { x: 22, y: 12 }],
};

// ---- Tool factory -----------------------------------------------------------

/// Fidelity parameter shared by the generator tools. 'hifi' (default) keeps
/// the template's full styling; 'lofi' post-processes the generated shapes to
/// a grayscale wireframe (no shadows, no gradients, neutral-ramp fills) for
/// explicit "wireframe / low-fi / sketch" requests. Before this existed the
/// generator ALWAYS emitted colorful styled output, so a "draw a low-fi
/// wireframe" prompt produced a hi-fi screen (caught by agent-eval
/// `wireframe-lofi`).
const FidelitySchema = Type.Union([Type.Literal('hifi'), Type.Literal('lofi')], {
  description:
    "Output fidelity. Use 'lofi' when the user explicitly asks for a wireframe / low-fi / sketch / graybox " +
    '(grayscale, flat, no shadows). Default hifi.',
});

/// Convert a hex color to its grayscale equivalent (luminance-preserving).
function toGrayscaleHex(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim());
  if (!m) return hex; // transparent / var() / non-hex — leave untouched
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  // Snap to the neutral ramp used by WIREFRAME MODE for a cohesive look.
  const ramp = [0x11, 0x37, 0x6b, 0x9c, 0xd1, 0xe5, 0xf8];
  const snapped = ramp.reduce((best, c) => (Math.abs(c - lum) < Math.abs(best - lum) ? c : best), ramp[0]);
  const v = (snapped << 16) | (snapped << 8) | snapped;
  return '#' + v.toString(16).padStart(6, '0');
}

/// Downgrade generated shapes to lo-fi wireframe styling in place.
/// Exported for unit tests (tests/unit/agent-eval-fixes.test.ts).
export function applyLofiFidelity(shapes: Array<Partial<Shape> & Record<string, unknown>>): void {
  for (const s of shapes) {
    if (typeof s.fill === 'string' && s.fill !== 'transparent') s.fill = toGrayscaleHex(s.fill);
    if (typeof s.textColor === 'string') {
      const gray = toGrayscaleHex(s.textColor);
      // Very light text on (formerly) dark fills would become unreadable on
      // light gray fills — force near-black instead.
      s.textColor = gray === '#f8f8f8' ? '#111827' : gray;
    }
    if (s.stroke && s.stroke !== 'transparent') s.stroke = '#d1d5db';
    delete s.shadow;
    delete s.gradient;
  }
}

/// Apply caller-supplied text overrides to generated shapes. Keys are matched
/// against text-layer names case-insensitively (exact match first, then
/// normalized whitespace). Returns how many overrides were applied.
/// Exported for unit tests.
export function applyTextOverrides(
  shapes: Array<Partial<Shape> & Record<string, unknown>>,
  texts: Record<string, string> | undefined,
): number {
  if (!texts || typeof texts !== 'object') return 0;
  const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ');
  const entries = Object.entries(texts).filter(([k, v]) => typeof k === 'string' && typeof v === 'string' && v.length > 0);
  if (entries.length === 0) return 0;
  let applied = 0;
  const used = new Set<string>();
  for (const s of shapes) {
    if (s.type !== 'text') continue;
    const name = norm(String(s.name ?? ''));
    for (const [key, value] of entries) {
      if (used.has(key)) continue;
      if (norm(key) === name) {
        s.text = value;
        used.add(key);
        applied++;
        break;
      }
    }
  }
  return applied;
}

export function createCanvasTools(ctx: CanvasToolContext) {
  // =====================================================================
  // CORE CANVAS OPS (existing)
  // =====================================================================

const createShape = defineTool({
    name: 'pen_create_node',
    label: 'Create Node',
    description:
      'Create a new node on the canvas — the workhorse. Use this to add rectangles, ellipses, text, lines, frames (artboards), or groups. ' +
      'Returns the new node id. The node appears immediately on every viewer\'s screen.',
    promptSnippet: 'Create canvas nodes (rectangle, ellipse, text, line, frame).',
    promptGuidelines: [
      'When the user asks to "add" / "draw" / "create" / "put" a node, use pen_create_node.',
      'Always specify `type`, `x`, `y`, `width`, `height`. For text nodes include `text`, `fontSize`, `textColor`.',
      'Coordinates are canvas-space pixels; the visible area at zoom 1 is roughly 0..1200 x 0..800.',
    ],
    parameters: ShapeInputSchema,
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const id = crypto.randomUUID();
      const coerced = coerceShapeInput(params);
      // Default type to 'rectangle' if the LLM omitted it.
      if (!coerced.type) coerced.type = 'rectangle';
      const patch: CanvasPatch = {
        op: 'add',
        shapeId: id,
        shape: { id, ...coerced, zIndex: ctx.getShapes().length },
        summary: `Created ${coerced.type}${params.name ? ` "${params.name}"` : ''} at (${coerced.x ?? 0}, ${coerced.y ?? 0})`,
      };
      ctx.applyPatch(patch);
      return {
        content: [
          {
            type: 'text',
            text: `Created ${coerced.type} with id ${id}. Coordinates: (${coerced.x ?? 0}, ${coerced.y ?? 0}), size ${coerced.width ?? 100}×${coerced.height ?? 100}.`,
          },
        ],
        details: { shapeId: id, patch },
      };
    },
  });

  const updateShape = defineTool({
    name: 'pen_update_node',
    label: 'Update Node',
    description:
      'Update one or more properties of an existing node. Only the fields you provide are changed; others stay the same. ' +
      'Use this to move, resize, recolor, or edit text. Returns the patched node.',
    promptSnippet: 'Update properties of an existing node (position, size, fill, text, …).',
    promptGuidelines: [
      'Call pen_get_metadata first if you don\'t know the node id.',
      'You may pass any subset of node properties — only the ones you include are changed.',
      'To change text content, set `text`. To change color, set `fill` (hex like #ff0000).',
    ],
    parameters: Type.Object({
      nodeId: Type.Optional(Type.String({ description: 'ID of the node to update (aliases: id, shapeId)' })),
      id: Type.Optional(Type.String({ description: 'Alias for nodeId' })),
      shapeId: Type.Optional(Type.String({ description: 'Legacy alias for nodeId' })),
      changes: Type.Optional(LooseShapeInputSchema),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      // Tolerate LLMs that pass `id` or the legacy `shapeId` instead of `nodeId`
      // (normalizeToolParams folds shapeId→nodeId at the execution boundary;
      // the fallbacks here cover direct execute calls).
      const shapeId = params.nodeId ?? params.shapeId ?? (params as any).id;
      const existing = ctx.getShapes().find((s) => s.id === shapeId);
      if (!existing) {
        return {
          content: [{ type: 'text', text: `Error: no shape with id ${shapeId}` }],
          details: { error: 'not_found', shapeId },
          isError: true as any,
        };
      }
      // Tolerate LLMs that pass changes as top-level fields instead of
      // nesting them under `changes`. If `changes` is missing/empty but
      // the LLM passed x/y/fill/etc at the top level, treat those as the
      // changes. (parseLooseShapeInput already handled JSON-string changes.)
      let rawChanges = parseLooseShapeInput(params.changes);
      if (!rawChanges || Object.keys(rawChanges).length === 0) {
        // Strip metadata fields, keep shape fields.
        const { nodeId: _n, shapeId: _s, id: _i, changes: _c, ...rest } = params as any;
        rawChanges = rest;
      }
      // Figma-hierarchy safety net: the LLM may pass `parent` or `parentId`
      // in the changes (a natural intuition — pen.dev uses `parent`). The
      // update patch applier silently DROPS this field because ShapeInputSchema
      // doesn't declare it. Detect it here and route to a separate `reparent`
      // patch so the LLM's intent is honored, instead of failing silently.
      // The response also tells the LLM to use pen_reparent_nodes directly
      // next time — turning a silent failure into a successful reparent + an
      // LLM education hint.
      let reparentPatch: CanvasPatch | null = null;
      let reparentHint = '';
      const changesAny = rawChanges as any;
      if (changesAny && (changesAny.parent !== undefined || changesAny.parentId !== undefined)) {
        const newParentRaw = changesAny.parent !== undefined ? changesAny.parent : changesAny.parentId;
        // Normalize: empty string / null / undefined → null (root).
        const newParentId =
          newParentRaw === null || newParentRaw === '' || newParentRaw === undefined
            ? null
            : String(newParentRaw);
        // Validate that the new parent (if not null) exists and is a container.
        if (newParentId) {
          const newParent = ctx.getShapes().find((s) => s.id === newParentId);
          if (!newParent) {
            return {
              content: [{ type: 'text', text: `Error: cannot reparent — no shape with id ${newParentId}. Hint: use pen_reparent_nodes for moving nodes between parents.` }],
              details: { error: 'parent_not_found', newParentId },
              isError: true as any,
            };
          }
          if (newParent.type !== 'frame' && newParent.type !== 'group') {
            return {
              content: [{ type: 'text', text: `Error: cannot reparent into ${newParent.type} "${newParent.name}" — parent must be a frame or group. Hint: use pen_reparent_nodes.` }],
              details: { error: 'parent_not_container', parentType: newParent.type },
              isError: true as any,
            };
          }
        }
        // Don't allow reparenting into self.
        if (newParentId === shapeId) {
          return {
            content: [{ type: 'text', text: `Error: cannot reparent a shape into itself.` }],
            details: { error: 'cycle_self' },
            isError: true as any,
          };
        }
        reparentPatch = {
          op: 'reparent',
          shapeId,
          newParentId,
          keepAbsolutePosition: true,
          summary: `Reparented ${existing.name} → ${newParentId ? 'new parent' : 'root'} (via pen_update_node parent arg)`,
        };
        // Strip parent/parentId from the changes so the update patch doesn't
        // also try to set them (the update op would silently drop them anyway,
        // but stripping keeps the changes payload clean).
        const { parent: _p, parentId: _pi, ...restChanges } = changesAny;
        rawChanges = restChanges;
        reparentHint = ` Also reparented to ${newParentId ? `parent ${newParentId}` : 'root'} (TIP: use pen_reparent_nodes directly for explicit reparenting).`;
      }
      const coerced = coerceShapeInput(rawChanges);
      // If the LLM passed no actual changes (e.g. only `parent`), and we
      // already emitted a reparent patch, don't bail — return the reparent
      // result. If there's truly nothing to do, bail.
      if (Object.keys(coerced).length === 0 && !reparentPatch) {
        return {
          content: [{ type: 'text', text: `No changes provided for ${existing.name}.` }],
          details: { shapeId },
        };
      }
      const patches: CanvasPatch[] = [];
      if (Object.keys(coerced).length > 0) {
        patches.push({
          op: 'update',
          shapeId,
          shape: coerced,
          summary: `Updated ${existing.name}: ${Object.keys(coerced).join(', ')}`,
        });
      }
      if (reparentPatch) patches.push(reparentPatch);
      // Apply patches in order: update first (sets x/y/etc.), then reparent
      // (which preserves the absolute position computed from the new x/y).
      for (const p of patches) ctx.applyPatch(p);
      const changedKeys = patches.flatMap((p) => Object.keys(p.shape ?? {}));
      return {
        content: [
          { type: 'text', text: `Updated ${existing.name} (${shapeId}).${changedKeys.length ? ` Changed: ${changedKeys.join(', ')}.` : ''}${reparentHint}` },
        ],
        details: { shapeId, patch: patches[0], patches },
      };
    },
  });

  const deleteShape = defineTool({
    name: 'pen_delete_nodes',
    label: 'Delete Nodes',
    description: 'Delete one or more nodes from the canvas by id. This is permanent for the current session.',
    promptSnippet: 'Delete nodes by id.',
    promptGuidelines: [
      'Use pen_get_metadata to find ids before deleting.',
      'You can delete multiple nodes in one call by passing multiple ids.',
    ],
    parameters: Type.Object({
      nodeIds: Type.Array(Type.String(), { description: 'Ids of nodes to delete (legacy alias: shapeIds)' }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      // Defensive against LLM arg-shape errors: the schema says nodeIds is an
      // array, but LLMs occasionally pass `nodeId` (singular) or omit it
      // entirely. Coerce to an empty array so we return a proper "not found"
      // error instead of crashing inside `params.nodeIds.includes(...)`.
      // (Cast through `any` because the schema only declares `nodeIds`, but
      // we intentionally check for the common LLM mistakes of passing the
      // singular or the legacy spelling.)
      const p = params as any;
      const shapeIds: string[] = Array.isArray(p?.nodeIds)
        ? p.nodeIds.filter((id: unknown): id is string => typeof id === 'string')
        : (typeof p?.nodeId === 'string' ? [p.nodeId]
          : Array.isArray(p?.shapeIds)
            ? p.shapeIds.filter((id: unknown): id is string => typeof id === 'string')
            : (typeof p?.shapeId === 'string' ? [p.shapeId] : []));
      const existing = ctx.getShapes().filter((s) => shapeIds.includes(s.id));
      if (existing.length === 0) {
        return {
          content: [{ type: 'text', text: `No shapes found with ids: ${shapeIds.join(', ') || '(none)'}` }],
          details: { error: 'not_found' },
          isError: true as any,
        };
      }
      const patch: CanvasPatch = {
        op: 'remove',
        shapeIds,
        summary: `Deleted ${existing.length} shape${existing.length === 1 ? '' : 's'}: ${existing.map((s) => s.name).join(', ')}`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Deleted ${existing.length} shape(s): ${existing.map((s) => `${s.name} (${s.id})`).join(', ')}.` }],
        details: { patch, deletedCount: existing.length },
      };
    },
  });

  // (pen_list_shapes was superseded by pen_get_metadata — spec Phase 6 / G.3.
  //  The legacy name stays callable via the alias registry in tool-aliases.ts:
  //  it resolves to pen_get_metadata and appends a migration notice.)

  const clearCanvas = defineTool({
    name: 'pen_clear',
    label: 'Clear Canvas',
    description: 'Remove every shape from the canvas. Use sparingly — this is destructive and cannot be undone in this demo.',
    promptSnippet: 'Wipe the canvas clean.',
    promptGuidelines: [
      'Only use when the user explicitly asks to "clear" or "start over".',
    ],
    parameters: Type.Object({}),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const patch: CanvasPatch = { op: 'clear', summary: 'Cleared canvas' };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: 'Canvas cleared.' }],
        details: { patch },
      };
    },
  });

  const setBackground = defineTool({
    name: 'pen_set_background',
    label: 'Set Background',
    description: 'Set the canvas background color.',
    promptSnippet: 'Set canvas background color.',
    parameters: Type.Object({
      color: Type.String({ description: 'Background color hex, e.g. #ffffff' }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const patch: CanvasPatch = {
        op: 'background',
        background: params.color,
        summary: `Set background to ${params.color}`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Canvas background set to ${params.color}.` }],
        details: { patch },
      };
    },
  });

  const selectShape = defineTool({
    name: 'pen_select_nodes',
    label: 'Select Nodes',
    description:
      'Visually highlight one or more nodes on the canvas (a brief flash). Use this to point at a node you just created or are describing.',
    promptSnippet: 'Visually highlight nodes on the canvas.',
    parameters: Type.Object({
      nodeIds: Type.Array(Type.String(), { description: 'Node ids to select (legacy alias: shapeIds)' }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const p = params as any;
      const nodeIds: string[] = Array.isArray(p?.nodeIds)
        ? p.nodeIds.filter((id: unknown): id is string => typeof id === 'string')
        : (Array.isArray(p?.shapeIds) ? p.shapeIds : []);
      const patch: CanvasPatch = {
        op: 'select',
        shapeIds: nodeIds,
        summary: `Selected ${nodeIds.length} node(s)`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Highlighted ${nodeIds.length} node(s).` }],
        details: { patch },
      };
    },
  });

  // =====================================================================
  // LAYER ORGANIZATION (research: Figma layers panel + AI plugins)
  // =====================================================================

  const duplicateShape = defineTool({
    name: 'pen_duplicate_nodes',
    label: 'Duplicate Nodes',
    description:
      'Duplicate one or more nodes. Each copy is offset 24px down-right from its original. ' +
      'Returns the new node ids. Useful for repeating elements (lists, grids).',
    promptSnippet: 'Duplicate nodes (with new ids).',
    promptGuidelines: [
      'Use this when the user asks to "copy" / "duplicate" / "repeat" a node.',
      'The duplicate is offset 24px — use pen_align_shapes or pen_update_node to reposition.',
    ],
    parameters: Type.Object({
      nodeIds: Type.Array(Type.String(), { description: 'Ids of nodes to duplicate (legacy alias: shapeIds)' }),
      offsetX: Type.Optional(Type.Number({ description: 'Horizontal offset in px (default 24)' })),
      offsetY: Type.Optional(Type.Number({ description: 'Vertical offset in px (default 24)' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const ox = params.offsetX ?? 24;
      const oy = params.offsetY ?? 24;
      const p = params as any;
      const nodeIds: string[] = Array.isArray(p?.nodeIds)
        ? p.nodeIds.filter((id: unknown): id is string => typeof id === 'string')
        : (Array.isArray(p?.shapeIds) ? p.shapeIds : []);
      const patch: CanvasPatch = {
        op: 'duplicate',
        shapeIds: nodeIds,
        summary: `Duplicated ${nodeIds.length} node(s)`,
      };
      // The patch ops carry the offset implicitly (see patch.ts duplicate case).
      // We can't pass per-call offsets through CanvasPatch without extending
      // the type — so we ignore custom offsets here and apply the default.
      // (If the user really needs custom offsets, they can update_node after.)
      void ox; void oy;
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Duplicated ${nodeIds.length} node(s) (offset 24px).` }],
        details: { patch },
      };
    },
  });

  const groupShapes = defineTool({
    name: 'pen_group_shapes',
    label: 'Group Shapes',
    description:
      'Wrap one or more shapes in a group. The group becomes a new container shape with its own bounding box; ' +
      'children keep their position but gain a parentId pointing at the group. Use this to organize related shapes.',
    promptSnippet: 'Wrap shapes in a group.',
    parameters: Type.Object({
      shapeIds: Type.Array(Type.String(), { description: 'Ids to group' }),
      name: Type.Optional(Type.String({ description: 'Optional group name' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const patch: CanvasPatch = {
        op: 'group',
        shapeIds: params.shapeIds,
        summary: `Grouped ${params.shapeIds.length} shape(s)${params.name ? ` as "${params.name}"` : ''}`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Grouped ${params.shapeIds.length} shape(s).` }],
        details: { patch },
      };
    },
  });

  const ungroupShapes = defineTool({
    name: 'pen_ungroup_shapes',
    label: 'Ungroup Shapes',
    description: 'Dissolve one or more groups. Children are promoted to the group\'s parent (grandparent) and ' +
      'their stored x/y is remapped to preserve their absolute canvas position (Figma-hierarchy behavior).',
    promptSnippet: 'Dissolve groups (children keep their absolute position).',
    parameters: Type.Object({
      groupIds: Type.Array(Type.String(), { description: 'Ids of group shapes to dissolve' }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const patch: CanvasPatch = {
        op: 'ungroup',
        shapeIds: params.groupIds,
        summary: `Ungrouped ${params.groupIds.length} group(s)`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Ungrouped ${params.groupIds.length} group(s).` }],
        details: { patch },
      };
    },
  });

  // =====================================================================
  // FIGMA HIERARCHY: explicit reparent + constraints
  // (research: developers.figma.com/docs/plugins/api/FrameNode)
  // =====================================================================

  const reparentShape = defineTool({
    name: 'pen_reparent_nodes',
    label: 'Reparent Nodes',
    description:
      'Move one or more nodes to a new parent (frame or group). Figma-hierarchy semantics: by default each ' +
      'node\'s absolute canvas position is preserved by remapping its stored relative x/y to the new parent\'s ' +
      'coordinate frame. Pass keepAbsolutePosition=false to keep the stored x/y verbatim against the new ' +
      'parent. Reparenting into the node itself or one of its descendants is rejected (would create a cycle). ' +
      'Supports batch mode: pass nodeIds (plural) to reparent multiple nodes into the same new parent in one call.',
    promptSnippet: 'Move node(s) to a new parent (frame/group).',
    promptGuidelines: [
      'The new parent must be a frame or group (containers only). Use null/empty for root.',
      'By default each node\'s absolute position is preserved — pass keepAbsolutePosition=false only when ' +
        'you want the stored relative x/y to be reinterpreted verbatim against the new parent.',
      'Pass nodeIds (plural array) for batch reparent — all nodes go to the SAME new parent. ' +
        'Example: nodeIds=["a","b"], parentId="frame1".',
    ],
    parameters: Type.Object({
      nodeIds: Type.Optional(Type.Array(Type.String(), { description: 'IDs of nodes to move (batch). All nodes reparent to the SAME new parent in one call. Legacy alias: shapeIds.' })),
      nodeId: Type.Optional(Type.String({ description: 'ID of a single node to move (alias for nodeIds: [nodeId]). Legacy alias: shapeId.' })),
      parentId: Type.Optional(Type.Union(
        [Type.String({ description: 'ID of the new parent (frame or group)' }), Type.Null()],
        { description: 'New parent ID, or null/empty to move to root (top-level). Aliases: newParentId, parent.' },
      )),
      newParentId: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Legacy alias for parentId (.pen 2.17 spelling)' })),
      parent: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Alias for parentId' })),
      index: Type.Optional(Type.Number({ description: 'Insertion index inside the new parent\'s children. Default = append. Only applies to single-node reparent.' })),
      keepAbsolutePosition: Type.Optional(Type.Boolean({ description: 'Default true — remap x/y so the node stays put visually. False = keep stored x/y verbatim.' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const shapes = ctx.getShapes();
      // Tolerate argument-shape variations (normalizeToolParams folds the
      // legacy spellings onto the canonical ones at the execution boundary):
      //   - nodeIds (plural array, batch) — primary.
      //   - nodeId (singular string) — alias, treat as [nodeId].
      const ids: string[] = Array.isArray(params.nodeIds)
        ? params.nodeIds.filter((id: unknown): id is string => typeof id === 'string')
        : (typeof params.nodeId === 'string' ? [params.nodeId]
          : Array.isArray((params as any).shapeIds)
            ? ((params as any).shapeIds as unknown[]).filter((id): id is string => typeof id === 'string')
            : (typeof (params as any).shapeId === 'string' ? [(params as any).shapeId] : []));
      if (ids.length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: no nodeId(s) provided. Pass nodeIds (array) or nodeId (string).' }],
          details: { error: 'no_shape_ids' },
          isError: true as any,
        };
      }
      // Resolve parentId from any of the aliases.
      const newParentRaw = params.parentId ?? params.newParentId ?? params.parent ?? null;
      const newParentId: string | null =
        newParentRaw === null || newParentRaw === '' || newParentRaw === undefined
          ? null
          : String(newParentRaw);
      // Validate new parent (if not null) — must be a frame or group.
      if (newParentId) {
        const parent = shapes.find((s) => s.id === newParentId);
        if (!parent) {
          return {
            content: [{ type: 'text', text: `Error: no parent shape with id ${newParentId}` }],
            details: { error: 'parent_not_found', newParentId },
            isError: true as any,
          };
        }
        if (parent.type !== 'frame' && parent.type !== 'group') {
          return {
            content: [{ type: 'text', text: `Error: parent must be a frame or group, got ${parent.type} "${parent.name}"` }],
            details: { error: 'parent_not_container', parentType: parent.type },
            isError: true as any,
          };
        }
      }
      // Reparent each node, collecting patches + per-node errors.
      // Cycle prevention is handled by the patch applier (moveNode uses
      // isDescendant). We collect errors but still apply the valid reparents.
      const patches: CanvasPatch[] = [];
      const errors: string[] = [];
      const keepAbsolute = params.keepAbsolutePosition ?? true;
      for (const id of ids) {
        const shape = shapes.find((s) => s.id === id);
        if (!shape) { errors.push(`no node with id ${id}`); continue; }
        if (newParentId === id) { errors.push(`cannot reparent "${shape.name}" into itself`); continue; }
        patches.push({
          op: 'reparent',
          shapeId: id,
          newParentId,
          index: ids.length === 1 ? params.index : undefined, // index only valid for single-node reparent
          keepAbsolutePosition: keepAbsolute,
          summary: `Reparented "${shape.name}" → ${newParentId ? `parent "${shapes.find((s) => s.id === newParentId)?.name ?? newParentId}"` : 'root'}`,
        });
      }
      // Apply patches in order. The patch applier does cycle detection per call.
      for (const p of patches) ctx.applyPatch(p);
      const parentLabel = newParentId ? `parent "${newParentId}"` : 'root';
      const summary = patches.length === 0
        ? `Reparent failed: ${errors.join('; ')}`
        : `Reparented ${patches.length} node(s) → ${parentLabel}.${errors.length ? ` Errors: ${errors.join('; ')}` : ''}`;
      const isError = patches.length === 0;
      return {
        content: [{ type: 'text', text: isError ? `Error: ${summary}` : summary }],
        details: { patch: patches[0], patches, errors, shapeIds: ids, newParentId },
        isError: isError ? true as any : undefined,
      };
    },
  });

  const setConstraints = defineTool({
    name: 'pen_set_constraints',
    label: 'Set Layout Constraints',
    description:
      'Set Figma-style layout constraints on a child node. The renderer does not yet enforce these, but the ' +
      'Properties panel and the agent can read them to reason about responsive resize behavior. ' +
      'Horizontal: left / right / center / scale / left_right. Vertical: top / bottom / center / scale / top_bottom. ' +
      'Pass null to clear.',
    promptSnippet: 'Set Figma-style layout constraints on a child (left/right/center/scale).',
    promptGuidelines: [
      'Constraints only matter for children of frames/groups. Setting them on a top-level node has no effect.',
      'Common pairs: { horizontal: "left_right", vertical: "top_bottom" } (scales with parent), ' +
        '{ horizontal: "center", vertical: "center" } (centered), { horizontal: "left", vertical: "top" } (fixed).',
    ],
    parameters: Type.Object({
      shapeId: Type.String({ description: 'ID of the node to set constraints on' }),
      horizontal: Type.Union(
        [
          Type.Literal('left'),
          Type.Literal('right'),
          Type.Literal('center'),
          Type.Literal('scale'),
          Type.Literal('left_right'),
        ],
        { description: 'Horizontal constraint' },
      ),
      vertical: Type.Union(
        [
          Type.Literal('top'),
          Type.Literal('bottom'),
          Type.Literal('center'),
          Type.Literal('scale'),
          Type.Literal('top_bottom'),
        ],
        { description: 'Vertical constraint' },
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const shape = ctx.getShapes().find((s) => s.id === params.shapeId);
      if (!shape) {
        return {
          content: [{ type: 'text', text: `Error: no shape with id ${params.shapeId}` }],
          details: { error: 'not_found', shapeId: params.shapeId },
          isError: true as any,
        };
      }
      const patch: CanvasPatch = {
        op: 'set_constraints',
        shapeId: params.shapeId,
        constraints: { horizontal: params.horizontal, vertical: params.vertical },
        summary: `Set constraints on "${shape.name}" → ${params.horizontal}/${params.vertical}`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Set constraints on "${shape.name}" → ${params.horizontal}/${params.vertical}.` }],
        details: { patch, shapeId: params.shapeId, constraints: patch.constraints },
      };
    },
  });

  const alignShapes = defineTool({
    name: 'pen_align_shapes',
    label: 'Align / Distribute Shapes',
    description:
      'Align or distribute multiple shapes. Alignment snaps to min/max/average; distribution spaces them evenly. ' +
      'Requires at least 2 shapes for alignment, 3+ for distribution.',
    promptSnippet: 'Align or distribute shapes (left/right/center/top/bottom/distribute).',
    parameters: Type.Object({
      shapeIds: Type.Array(Type.String(), { description: 'Ids of shapes to align (min 2)' }),
      kind: Type.Union(
        [
          Type.Literal('left'),
          Type.Literal('right'),
          Type.Literal('center_h'),
          Type.Literal('top'),
          Type.Literal('bottom'),
          Type.Literal('center_v'),
          Type.Literal('distribute_h'),
          Type.Literal('distribute_v'),
        ],
        { description: 'Alignment kind' },
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const patch: CanvasPatch = {
        op: 'align',
        shapeIds: params.shapeIds,
        alignKind: params.kind,
        summary: `Aligned ${params.shapeIds.length} shape(s) ${params.kind}`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Aligned ${params.shapeIds.length} shape(s) (${params.kind}).` }],
        details: { patch },
      };
    },
  });

  const organizeLayers = defineTool({
    name: 'pen_organize_layers',
    label: 'Organize Layers',
    description:
      'Automatically rename and re-zIndex all shapes based on type and reading order. ' +
      'Rectangles become "Card N", ellipses "Ellipse N", text shapes take their text content (truncated), ' +
      'frames become "Frame N". Useful for cleaning up messy canvases.',
    promptSnippet: 'Auto-rename and re-order layers by type and position.',
    parameters: Type.Object({}),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const shapes = ctx.getShapes();
      const counters: Record<string, number> = {};
      const updates: Array<{ id: string; changes: Partial<Shape> }> = [];
      // Sort by reading order: top-to-bottom, left-to-right.
      const sorted = [...shapes].sort((a, b) => (a.y - b.y) || (a.x - b.x));
      sorted.forEach((s, idx) => {
        counters[s.type] = (counters[s.type] ?? 0) + 1;
        let name = `${capitalize(s.type)} ${counters[s.type]}`;
        if (s.type === 'text' && s.text) {
          name = s.text.slice(0, 24) + (s.text.length > 24 ? '…' : '');
        }
        updates.push({ id: s.id, changes: { name, zIndex: idx } });
      });
      const patch: CanvasPatch = {
        op: 'update_many',
        updates,
        summary: `Organized ${updates.length} layer(s)`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Reorganized ${updates.length} layer(s).` }],
        details: { patch, count: updates.length },
      };
    },
  });

  // =====================================================================
  // AUTO LAYOUT (research: Figma Auto Layout)
  // =====================================================================

  const applyAutoLayout = defineTool({
    name: 'pen_apply_auto_layout',
    label: 'Apply Auto Layout',
    description:
      'Apply an Auto Layout configuration to a frame or group. The container\'s children will be arranged ' +
      'automatically based on direction, gap, padding, and alignment (mirrors Figma Auto Layout). ' +
      'Only meaningful for `frame` or `group` shapes.',
    promptSnippet: 'Configure Auto Layout on a frame/group (direction, gap, padding, alignment).',
    promptGuidelines: [
      'The frame must already exist — create it with pen_create_node first.',
      'Children (shapes whose parentId points at this frame) will be repositioned.',
    ],
    parameters: Type.Object({
      frameId: Type.String({ description: 'ID of the frame/group to apply Auto Layout to' }),
      direction: Type.Union([Type.Literal('horizontal'), Type.Literal('vertical')], { description: 'Layout direction' }),
      gap: Type.Optional(Type.Number({ description: 'Gap between children in px (default 8)' })),
      padding: Type.Optional(Type.Number({ description: 'Inner padding in px (default 16)' })),
      alignX: Type.Optional(Type.Union([Type.Literal('min'), Type.Literal('center'), Type.Literal('max')], { description: 'Horizontal alignment (default center)' })),
      alignY: Type.Optional(Type.Union([Type.Literal('min'), Type.Literal('center'), Type.Literal('max')], { description: 'Vertical alignment (default center)' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const frame = ctx.getShapes().find((s) => s.id === params.frameId);
      if (!frame) {
        return {
          content: [{ type: 'text', text: `Error: no frame with id ${params.frameId}` }],
          details: { error: 'not_found' },
          isError: true as any,
        };
      }
      const autoLayout: AutoLayout = {
        direction: params.direction,
        gap: params.gap ?? 8,
        padding: params.padding ?? 16,
        alignX: params.alignX ?? 'center',
        alignY: params.alignY ?? 'center',
      };
      // Find children, reposition them per the auto-layout rules.
      const children = ctx.getShapes().filter((s) => s.parentId === params.frameId);
      const updates: Array<{ id: string; changes: Partial<Shape> }> = [];
      const pad = autoLayout.padding;
      if (autoLayout.direction === 'horizontal') {
        let cursor = frame.x + pad;
        for (const child of children) {
          const cy =
            autoLayout.alignY === 'min' ? frame.y + pad :
            autoLayout.alignY === 'max' ? frame.y + frame.height - pad - child.height :
            frame.y + (frame.height - child.height) / 2;
          updates.push({ id: child.id, changes: { x: cursor, y: cy } });
          cursor += child.width + autoLayout.gap;
        }
      } else {
        let cursor = frame.y + pad;
        for (const child of children) {
          const cx =
            autoLayout.alignX === 'min' ? frame.x + pad :
            autoLayout.alignX === 'max' ? frame.x + frame.width - pad - child.width :
            frame.x + (frame.width - child.width) / 2;
          updates.push({ id: child.id, changes: { x: cx, y: cursor } });
          cursor += child.height + autoLayout.gap;
        }
      }
      // First update the frame itself (set autoLayout), then update children.
      const framePatch: CanvasPatch = {
        op: 'update',
        shapeId: params.frameId,
        shape: { autoLayout },
        summary: `Applied ${autoLayout.direction} Auto Layout to "${frame.name}"`,
      };
      ctx.applyPatch(framePatch);
      if (updates.length > 0) {
        const childrenPatch: CanvasPatch = {
          op: 'update_many',
          updates,
          summary: `Repositioned ${updates.length} child(ren) per Auto Layout`,
        };
        ctx.applyPatch(childrenPatch);
      }
      return {
        content: [
          {
            type: 'text',
            text: `Applied ${autoLayout.direction} Auto Layout to frame "${frame.name}" (gap=${autoLayout.gap}, pad=${autoLayout.padding}). ${updates.length} children repositioned.`,
          },
        ],
        details: { patch: framePatch, childrenCount: updates.length },
      };
    },
  });

  // =====================================================================
  // COMPONENTS & VARIANTS (research: Figma components + AI plugins)
  // =====================================================================

  // (Spec Phase 6 / G.3: the legacy mark-a-shape-as-component tool that lived
  //  under `pen_create_component` here was folded away — the canonical
  //  `pen_create_component` is now the Figma-shaped create-a-new-COMPONENT
  //  tool in figma-tools.ts (the figma_ spelling is a permanent alias), and
  //  the mark-an-existing-shape flow is served by pen_convert_to_component,
  //  which takes the identical shapeId param and produces a proper Component.)

  const instantiateComponent = defineTool({
    name: 'pen_instantiate_component',
    label: 'Instantiate Component',
    description:
      'Create a linked instance of an existing component. The instance copies the component\'s shape but ' +
      'gets a new id and componentId pointing at the original. Useful for placing the same UI element multiple times.',
    promptSnippet: 'Place a linked instance of a component.',
    parameters: Type.Object({
      componentId: Type.String({ description: 'ID of the source component' }),
      x: Type.Number({ description: 'X position for the new instance' }),
      y: Type.Number({ description: 'Y position for the new instance' }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const src = ctx.getShapes().find((s) => s.id === params.componentId);
      if (!src) {
        return {
          content: [{ type: 'text', text: `Error: no component with id ${params.componentId}` }],
          details: { error: 'not_found' },
          isError: true as any,
        };
      }
      const id = crypto.randomUUID();
      const patch: CanvasPatch = {
        op: 'add',
        shapeId: id,
        shape: {
          id,
          type: src.type,
          name: `${src.name} instance`,
          x: params.x,
          y: params.y,
          width: src.width,
          height: src.height,
          fill: src.fill,
          stroke: src.stroke,
          strokeWidth: src.strokeWidth,
          radius: src.radius,
          text: src.text,
          fontSize: src.fontSize,
          textColor: src.textColor,
          componentId: params.componentId,
          zIndex: ctx.getShapes().length,
        },
        summary: `Instantiated component "${src.name}" at (${params.x}, ${params.y})`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Created instance ${id} of component ${params.componentId}.` }],
        details: { patch, instanceId: id },
      };
    },
  });

  // =====================================================================
  // COMPONENT SYSTEM (Phase 2 — Figma-aligned components & design systems)
  //
  // These tools wrap the new patch ops in `src/lib/canvas/patch.ts` and expose
  // the full Figma component lifecycle to the agent:
  //
  //   1. pen_convert_to_component    — promote a frame to a reusable Component
  //   2. pen_place_component_instance — create a proper PenRef (linked instance)
  //   3. pen_override_instance        — set a descendant override on an instance
  //   4. pen_reset_instance           — clear all overrides on an instance
  //   5. pen_detach_instance          — break the link, bake into a plain frame
  //   6. pen_combine_as_variants      — wrap components into a ComponentSet
  //   7. pen_swap_variant             — switch which variant the instance shows
  //
  // The legacy `pen_instantiate_component` tool above is kept for backward
  // compat — it shallow-copies a shape without producing a proper PenRef.
  // New agent code should prefer the Phase 2 tools below (and
  // pen_create_component / figma_create_component for creating components).
  // =====================================================================

  const convertToComponent = defineTool({
    name: 'pen_convert_to_component',
    label: 'Convert to Component',
    description:
      'Promote an existing frame, group, or shape into a reusable Component (Figma: ⌘⇧O). ' +
      'The selected node becomes the "main component" — its type changes from "frame" to "component", ' +
      'and `reusable=true` is set so future instances can reference it via `pen_place_component_instance`. ' +
      'Use this AFTER designing a UI element you want to reuse (button, card, header, etc.).',
    promptSnippet: 'Turn a frame into a reusable component.',
    promptGuidelines: [
      'The selected shape should be a frame or group containing the component\'s visual elements.',
      'After converting, place instances via `pen_place_component_instance` — do NOT duplicate the main component.',
      'To create variants (e.g. Primary, Secondary, Disabled states), convert each variant into its own component first, then call `pen_combine_as_variants`.',
    ],
    parameters: Type.Object({
      shapeId: Type.String({ description: 'ID of the frame/group/shape to promote to a Component' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const shape = ctx.getShapes().find((s) => s.id === params.shapeId);
      if (!shape) {
        return {
          content: [{ type: 'text', text: `Error: no shape with id ${params.shapeId}` }],
          details: { error: 'not_found' },
          isError: true as any,
        };
      }
      const patch: CanvasPatch = {
        op: 'convert_to_component',
        shapeId: params.shapeId,
        summary: `Promoted "${shape.name}" to a reusable Component`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Shape "${shape.name}" is now a reusable Component (id=${params.shapeId}). Place instances via pen_place_component_instance.` }],
        details: { patch, componentId: params.shapeId },
      };
    },
  });

  const placeComponentInstance = defineTool({
    name: 'pen_place_component_instance',
    label: 'Place Component Instance',
    description:
      'Place a linked instance of a reusable Component at (x, y). Creates a proper PenRef node that ' +
      'references the main component. The instance inherits the main\'s full subtree and can be ' +
      'overridden locally (text, fill, stroke, child visibility) without affecting the main. ' +
      'When the main component changes, all instances update automatically.',
    promptSnippet: 'Place a linked instance of a reusable component.',
    promptGuidelines: [
      'Requires the source to be a reusable Component (convert first via `pen_convert_to_component`).',
      'The instance will inherit the main\'s width/height/fill/stroke — don\'t pass those here.',
      'To customize an instance (e.g. different label text), follow with `pen_override_instance`.',
    ],
    parameters: Type.Object({
      componentId: Type.String({ description: 'ID of the source (reusable) Component' }),
      x: Type.Number({ description: 'X position for the new instance (canvas-space)' }),
      y: Type.Number({ description: 'Y position for the new instance (canvas-space)' }),
      parentId: Type.Optional(Type.String({ description: 'Optional parent frame/group to insert into' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const id = crypto.randomUUID();
      const patch: CanvasPatch = {
        op: 'place_instance',
        shapeId: id,
        componentId: params.componentId,
        shape: {
          id,
          x: params.x,
          y: params.y,
          ...(params.parentId ? { parentId: params.parentId } : {}),
        },
        summary: `Placed instance of component ${params.componentId} at (${params.x}, ${params.y})`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Created instance ${id} of component ${params.componentId}.` }],
        details: { patch, instanceId: id },
      };
    },
  });

  const overrideInstance = defineTool({
    name: 'pen_override_instance',
    label: 'Override Instance Property',
    description:
      'Override a descendant property on a component instance (PenRef). Lets you customize one instance ' +
      'without affecting the main component or other instances. Supported overrides: text content, fill, ' +
      'stroke, opacity, visibility, fontSize, textColor, radius. The descendant path is slash-separated ' +
      'source-ids (e.g. "button-frame/label-text").',
    promptSnippet: 'Customize an instance (override text, fill, etc.).',
    promptGuidelines: [
      'Use the source-id path of the descendant inside the MAIN component (not the instance clone).',
      'Multiple overrides on the same instance accumulate — you don\'t need to re-send prior overrides.',
      'To revert: call `pen_reset_instance` to clear all overrides on an instance.',
    ],
    parameters: Type.Object({
      instanceId: Type.String({ description: 'ID of the PenRef instance to override' }),
      descendantPath: Type.String({ description: 'Slash-separated source-id path inside the main component (e.g. "button/label")' }),
      text: Type.Optional(Type.String({ description: 'Override text content (for text descendants)' })),
      fill: Type.Optional(Type.String({ description: 'Override fill color (hex, e.g. "#ef4444")' })),
      stroke: Type.Optional(Type.String({ description: 'Override stroke color (hex)' })),
      strokeWidth: Type.Optional(Type.Number({ description: 'Override stroke width in px' })),
      opacity: Type.Optional(Type.Number({ description: 'Override opacity (0..1)' })),
      visible: Type.Optional(Type.Boolean({ description: 'Override visibility (true=show, false=hide)' })),
      fontSize: Type.Optional(Type.Number({ description: 'Override font size in px' })),
      textColor: Type.Optional(Type.String({ description: 'Override text color (hex)' })),
      radius: Type.Optional(Type.Number({ description: 'Override corner radius in px' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const override: Record<string, unknown> = {};
      if (params.text !== undefined) override.text = params.text;
      if (params.fill !== undefined) override.fill = params.fill;
      if (params.stroke !== undefined) override.stroke = params.stroke;
      if (params.strokeWidth !== undefined) override.strokeWidth = params.strokeWidth;
      if (params.opacity !== undefined) override.opacity = params.opacity;
      if (params.visible !== undefined) override.visible = params.visible;
      if (params.fontSize !== undefined) override.fontSize = params.fontSize;
      if (params.textColor !== undefined) override.textColor = params.textColor;
      if (params.radius !== undefined) override.radius = params.radius;
      if (Object.keys(override).length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: at least one override property must be provided.' }],
          details: { error: 'no_overrides' },
          isError: true as any,
        };
      }
      const patch: CanvasPatch = {
        op: 'set_instance_override',
        shapeId: params.instanceId,
        descendantPath: params.descendantPath,
        override,
        summary: `Overrode ${params.descendantPath} on instance ${params.instanceId}`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Overrode ${Object.keys(override).join(', ')} on ${params.descendantPath} of instance ${params.instanceId}.` }],
        details: { patch },
      };
    },
  });

  const resetInstance = defineTool({
    name: 'pen_reset_instance',
    label: 'Reset Instance Overrides',
    description:
      'Clear ALL overrides on a component instance — re-sync from the main component. ' +
      'Equivalent to Figma\'s right-click → "Reset Instance" / "Reset Overrides".',
    promptSnippet: 'Reset all overrides on an instance.',
    parameters: Type.Object({
      instanceId: Type.String({ description: 'ID of the PenRef instance to reset' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const patch: CanvasPatch = {
        op: 'reset_instance',
        shapeId: params.instanceId,
        summary: `Reset all overrides on instance ${params.instanceId}`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Reset all overrides on instance ${params.instanceId}.` }],
        details: { patch },
      };
    },
  });

  const detachInstance = defineTool({
    name: 'pen_detach_instance',
    label: 'Detach Instance',
    description:
      'Detach a component instance from its main component (Figma: right-click → "Detach Instance"). ' +
      'The instance becomes a standalone frame containing the resolved tree (with overrides baked in). ' +
      'Future changes to the main component will NOT propagate to the detached frame. Use this when you ' +
      'need to heavily customize a single instance beyond what overrides allow.',
    promptSnippet: 'Detach an instance (break the link to the main component).',
    parameters: Type.Object({
      instanceId: Type.String({ description: 'ID of the PenRef instance to detach' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const patch: CanvasPatch = {
        op: 'detach_instance',
        shapeId: params.instanceId,
        summary: `Detached instance ${params.instanceId} from its main component`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Instance ${params.instanceId} is now a standalone frame (link broken).` }],
        details: { patch },
      };
    },
  });

  const combineAsVariants = defineTool({
    name: 'pen_combine_as_variants',
    label: 'Combine as Variants',
    description:
      'Wrap multiple Component nodes into a ComponentSet (Figma: select multiple components → "Combine as Variants"). ' +
      'The resulting set exposes the variant axes (e.g. Size, State) as a property picker on instances. ' +
      'Component naming convention MUST be "Property=Value, Property=Value" (e.g. "Size=Large, State=Default") ' +
      'for the axes to be auto-derived. You can also pass `axes` explicitly. After combining, instances of ' +
      'the SET can switch between variants via `pen_swap_variant`.',
    promptSnippet: 'Combine components into a variant set.',
    promptGuidelines: [
      'Components should be named "Property=Value, ..." — e.g. "Size=Large, State=Default".',
      'All components in a set should share the SAME property axes (same Property names).',
      'Axes are auto-derived from the first component\'s name if `axes` is omitted.',
    ],
    parameters: Type.Object({
      componentIds: Type.Array(Type.String(), { description: 'IDs of the components to combine (2+ required)' }),
      axes: Type.Optional(Type.Array(Type.String(), { description: 'Variant axes (e.g. ["Size", "State"]). Auto-derived if omitted.' })),
      name: Type.Optional(Type.String({ description: 'Display name for the component set (defaults to "Component Set")' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (params.componentIds.length < 2) {
        return {
          content: [{ type: 'text', text: 'Error: combine_as_variants requires at least 2 components.' }],
          details: { error: 'too_few_components' },
          isError: true as any,
        };
      }
      const setId = crypto.randomUUID();
      const patch: CanvasPatch = {
        op: 'combine_as_variants',
        shapeId: setId,
        componentIds: params.componentIds,
        axes: params.axes,
        shape: { name: params.name ?? 'Component Set' },
        summary: `Combined ${params.componentIds.length} components into a ComponentSet`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Created ComponentSet ${setId} with ${params.componentIds.length} variants.` }],
        details: { patch, componentSetId: setId },
      };
    },
  });

  const swapVariant = defineTool({
    name: 'pen_swap_variant',
    label: 'Swap Variant',
    description:
      'Switch which variant of a ComponentSet the instance points to. The instance keeps its existing ' +
      'overrides (text, fill, etc.) where the new variant has matching descendants. Equivalent to Figma\'s ' +
      'Properties panel variant dropdown.',
    promptSnippet: 'Switch an instance to a different variant.',
    parameters: Type.Object({
      instanceId: Type.String({ description: 'ID of the PenRef instance to update' }),
      variantComponentId: Type.String({ description: 'ID of the target variant (a Component inside the ComponentSet)' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const patch: CanvasPatch = {
        op: 'swap_variant',
        shapeId: params.instanceId,
        componentId: params.variantComponentId,
        summary: `Swapped instance ${params.instanceId} to variant ${params.variantComponentId}`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Instance ${params.instanceId} now points to variant ${params.variantComponentId}.` }],
        details: { patch },
      };
    },
  });

  // =====================================================================
  // DESIGN TOKENS / VARIABLES (research: Figma Variables + AI design systems)
  // =====================================================================

  const updateTokens = defineTool({
    name: 'pen_set_variables',
    label: 'Set Variables',
    description:
      'Update the document\'s variables — named colors and text styles that nodes can bind to. ' +
      'When a variable changes, every node bound to it (via tokenBinding) is recolored automatically. ' +
      'Pass only the variables you want to add or change; existing ones are merged by key.',
    promptSnippet: 'Update variables (color palette, text styles).',
    promptGuidelines: [
      'Variable keys use dotted paths: `bg.primary`, `accent`, `text.heading`, etc.',
      'After updating variables, use pen_apply_palette to bind nodes to them.',
    ],
    parameters: Type.Object({
      colors: Type.Optional(Type.Array(
        Type.Object({
          name: Type.String({ description: 'Human label, e.g. "Primary blue"' }),
          key: Type.String({ description: 'Token key, e.g. "accent" or "bg.primary"' }),
          value: Type.String({ description: 'Hex color, e.g. #0ea5e9' }),
        }),
        { description: 'Color tokens to add/update' },
      )),
      textStyles: Type.Optional(Type.Array(
        Type.Object({
          name: Type.String({ description: 'Style label, e.g. "Heading L"' }),
          key: Type.String({ description: 'Token key, e.g. "text.heading.l"' }),
          fontSize: Type.Number({ description: 'Font size in px' }),
          fontWeight: Type.Optional(Type.Number({ description: 'Font weight 100..900 (default 400)' })),
          lineHeight: Type.Optional(Type.Number({ description: 'Line height ratio (default 1.4)' })),
          color: Type.String({ description: 'Text color hex' }),
        }),
        { description: 'Text style tokens to add/update' },
      )),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const colors: ColorToken[] = (params.colors ?? []).map((c) => ({
        name: c.name,
        key: c.key,
        value: c.value,
      }));
      const textStyles: TextStyleToken[] = (params.textStyles ?? []).map((t) => ({
        name: t.name,
        key: t.key,
        fontSize: t.fontSize,
        fontWeight: t.fontWeight ?? 400,
        lineHeight: t.lineHeight ?? 1.4,
        color: t.color,
      }));
      const patch: CanvasPatch = {
        op: 'tokens',
        tokens: { colors, textStyles },
        summary: `Updated ${colors.length} color(s), ${textStyles.length} text style(s)`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Tokens updated: ${colors.length} colors, ${textStyles.length} text styles.` }],
        details: { patch, colorCount: colors.length, textStyleCount: textStyles.length },
      };
    },
  });

  const applyPalette = defineTool({
    name: 'pen_apply_palette',
    label: 'Apply Palette to Shapes',
    description:
      'Recolor a set of shapes using a new palette. Each shape\'s fill is mapped to the closest color in the palette ' +
      'by perceptual distance (HSL). Useful for "re-skinning" an existing layout without rebuilding it. ' +
      'Optionally binds the shapes to design tokens (so future palette changes propagate automatically). ' +
      'If shapeIds is omitted, applies to ALL shapes on the canvas — use this for "recolor everything" requests.',
    promptSnippet: 'Recolor shapes by mapping to a new palette (nearest match). Omit shapeIds to recolor all.',
    parameters: Type.Object({
      shapeIds: Type.Optional(Type.Array(Type.String(), { description: 'Ids of shapes to recolor. Omit to recolor ALL shapes on the canvas.' })),
      palette: Type.Array(Type.String(), { description: 'Array of hex colors to map to (e.g. ["#0f172a","#0ea5e9","#f8fafc"]). MUST be a real JSON array, not a stringified string.' }),
      bindToTokens: Type.Optional(Type.Boolean({ description: 'If true, create/update design tokens and bind shapes to them (default false)' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      // If shapeIds is omitted, apply to ALL shapes — this matches the common
      // "recolor everything" intent and avoids the crash when the LLM forgets
      // to pass shapeIds (which was happening ~50% of the time, causing the
      // "Cannot read properties of undefined (reading 'includes')" error).
      const allShapes = ctx.getShapes();
      const shapes = params.shapeIds && params.shapeIds.length > 0
        ? allShapes.filter((s) => params.shapeIds!.includes(s.id))
        : allShapes;
      if (shapes.length === 0) {
        return {
          content: [{ type: 'text', text: 'No matching shapes found. Pass shapeIds, or omit shapeIds to recolor all shapes.' }],
          details: { error: 'not_found' },
          isError: true as any,
        };
      }
      const paletteHsl = params.palette.map((hex) => ({ hex, hsl: hexToHsl(hex) }));
      const updates: Array<{ id: string; changes: Partial<Shape> }> = [];
      for (const s of shapes) {
        const sHsl = hexToHsl(s.fill);
        // Nearest by Euclidean distance in HSL space.
        let best = paletteHsl[0];
        let bestD = Infinity;
        for (const p of paletteHsl) {
          const dh = Math.min(Math.abs(sHsl.h - p.hsl.h), 360 - Math.abs(sHsl.h - p.hsl.h));
          const ds = sHsl.s - p.hsl.s;
          const dl = sHsl.l - p.hsl.l;
          const d = Math.sqrt(dh * dh + ds * ds + dl * dl);
          if (d < bestD) { bestD = d; best = p; }
        }
        const changes: Partial<Shape> = { fill: best.hex };
        if (s.type === 'text') {
          // For text shapes, set textColor to the darkest palette swatch.
          // Don't touch `fill` (previously, `changes.fill = s.fill` left the
          // text node with fill='transparent' AND patch.ts dropped the
          // textColor because fill was already set → all text invisible).
          // Include `type: 'text'` so patch.ts::toPenNodePartial knows
          // this is a text shape and lets textColor take precedence over
          // any pre-existing fill on the node.
          const darkest = [...paletteHsl].sort((a, b) => a.hsl.l - b.hsl.l)[0];
          changes.textColor = darkest.hex;
          changes.type = 'text';
          delete changes.fill;
        }
        updates.push({ id: s.id, changes });
      }
      const patch: CanvasPatch = {
        op: 'update_many',
        updates,
        summary: `Applied palette (${params.palette.length} colors) to ${updates.length} shape(s)`,
      };
      ctx.applyPatch(patch);
      // Optional: create tokens and bind.
      if (params.bindToTokens) {
        const colors: ColorToken[] = params.palette.map((hex, i) => ({
          name: `Palette ${i + 1}`,
          key: `palette.${i + 1}`,
          value: hex,
        }));
        const tokenPatch: CanvasPatch = {
          op: 'tokens',
          tokens: { colors, textStyles: [] },
          summary: `Saved palette as ${colors.length} color tokens`,
        };
        ctx.applyPatch(tokenPatch);
      }
      return {
        content: [{ type: 'text', text: `Applied palette to ${updates.length} shape(s).${params.bindToTokens ? ' Palette also saved as tokens.' : ''}` }],
        details: { patch, count: updates.length },
      };
    },
  });

  const generatePalette = defineTool({
    name: 'pen_generate_palette',
    label: 'Generate Harmonious Palette',
    description:
      'Generate a harmonious 5-color palette from a base color using color-theory rules. ' +
      'Returns the palette as a list of hex colors AND saves them as design tokens. ' +
      'Rules: analogous (adjacent hues), complementary (opposite), triadic (3 evenly spaced), ' +
      'monochromatic (variations of one hue), or split-complementary.',
    promptSnippet: 'Generate a 5-color palette from a base color (analogous, complementary, triadic, etc.).',
    parameters: Type.Object({
      baseColor: Type.String({ description: 'Base hex color, e.g. #0ea5e9' }),
      rule: Type.Union(
        [
          Type.Literal('analogous'),
          Type.Literal('complementary'),
          Type.Literal('triadic'),
          Type.Literal('monochromatic'),
          Type.Literal('split_complementary'),
        ],
        { description: 'Color harmony rule' },
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const base = hexToHsl(params.baseColor);
      let hues: number[] = [];
      switch (params.rule) {
        case 'analogous':
          hues = [base.h - 30, base.h - 15, base.h, base.h + 15, base.h + 30];
          break;
        case 'complementary':
          hues = [base.h, base.h, base.h, (base.h + 180) % 360, (base.h + 180) % 360];
          break;
        case 'triadic':
          hues = [base.h, (base.h + 120) % 360, (base.h + 240) % 360, base.h, (base.h + 120) % 360];
          break;
        case 'monochromatic':
          hues = [base.h, base.h, base.h, base.h, base.h];
          break;
        case 'split_complementary':
          hues = [base.h, base.h, (base.h + 150) % 360, (base.h + 210) % 360, base.h];
          break;
      }
      // Vary lightness across the palette.
      const lightnesses = params.rule === 'monochromatic'
        ? [25, 45, 60, 75, 90]
        : [35, 55, 70, 80, 90];
      const palette = hues.map((h, i) => {
        const hh = ((h % 360) + 360) % 360;
        return hslToHex(hh, base.s, lightnesses[i]);
      });
      // Save as tokens.
      const colors: ColorToken[] = palette.map((hex, i) => ({
        name: `${capitalize(params.rule)} ${i + 1}`,
        key: `palette.${i + 1}`,
        value: hex,
      }));
      const patch: CanvasPatch = {
        op: 'tokens',
        tokens: { colors, textStyles: [] },
        summary: `Generated ${params.rule} palette from ${params.baseColor}`,
      };
      ctx.applyPatch(patch);
      return {
        content: [
          {
            type: 'text',
            text: `Generated ${params.rule} palette: ${palette.join(', ')}.\nSaved as palette.1..palette.5 tokens. Use pen_apply_palette to apply to shapes.`,
          },
        ],
        details: { patch, palette, rule: params.rule },
      };
    },
  });

  // =====================================================================
  // WIREFRAME GENERATION (research: Uizard / Galileo AI / Figma Make)
  // =====================================================================

  const generateWireframe = defineTool({
    name: 'pen_generate_wireframe',
    label: 'Generate Screen',
    description:
      'Generate a screen layout from a template. Places a frame plus fully-styled shapes ' +
      'with shadows, gradients, radii, real content, and a color palette applied (fidelity=hifi, default). ' +
      'Pass fidelity=lofi for an explicit wireframe / low-fi / sketch request — grayscale, flat, no shadows. ' +
      'IMPORTANT: templates ship with PLACEHOLDER text (e.g. Stat values "$128.4K", "8,249"). When the user ' +
      'specifies exact copy — product names, headings, stat values, labels — pass them via `texts` ' +
      '(keyed by the template text layer name, e.g. {"Stat 1 value": "$128.4K", "Page title": "Acme Analytics"}) ' +
      'so the generated screen carries the user\'s real content in this same call. ' +
      'Templates: mobile_login, mobile_signup, mobile_dashboard, mobile_welcome, mobile_permissions, mobile_done, ' +
      'mobile_browse, mobile_product_detail, mobile_cart, mobile_checkout, web_landing, web_dashboard, web_blog, web_pricing. ' +
      'The frame is placed at (x, y) with the template\'s default size. ' +
      'This is a scaffold — follow it with pen_apply_palette, pen_set_shadow on cards/buttons, and pen_set_gradient_fill on the hero/CTA for full polish.',
    promptSnippet: 'Generate a screen from a template (mobile/web); fidelity=lofi for wireframes; texts for exact copy.',
    promptGuidelines: [
      'Use this for "make a login screen", "design a dashboard", "create a landing page", etc.',
      'When the user says wireframe / low-fi / sketch / graybox, pass fidelity=lofi and do NOT style afterwards.',
      'When the user gives exact copy (brand names, KPI values, headings), pass `texts` overrides in THIS call — never leave template placeholder values in the design.',
      'After a hifi generate, ALWAYS follow with: pen_apply_palette (bindToTokens=true), pen_set_shadow on cards/buttons, pen_set_gradient_fill on the hero/CTA, and pen_generate_copy for real content.',
      'A bare hifi generate_wireframe call with no styling pass is a wireframe, not a finished design.',
    ],
    parameters: Type.Object({
      template: Type.Union(
        [
          Type.Literal('mobile_login'),
          Type.Literal('mobile_signup'),
          Type.Literal('mobile_dashboard'),
          Type.Literal('mobile_welcome'),
          Type.Literal('mobile_permissions'),
          Type.Literal('mobile_done'),
          Type.Literal('mobile_browse'),
          Type.Literal('mobile_product_detail'),
          Type.Literal('mobile_cart'),
          Type.Literal('mobile_checkout'),
          Type.Literal('web_landing'),
          Type.Literal('web_dashboard'),
          Type.Literal('web_blog'),
          Type.Literal('web_pricing'),
        ],
        { description: 'Wireframe template' },
      ),
      x: Type.Optional(Type.Number({ description: 'Frame X position (default 100)' })),
      y: Type.Optional(Type.Number({ description: 'Frame Y position (default 100)' })),
      fidelity: Type.Optional(FidelitySchema),
      texts: Type.Optional(Type.Record(Type.String(), Type.String(), {
        description:
          'Override the template\'s placeholder text IN THIS CALL. Keys match generated text-layer names ' +
          '(case-insensitive, e.g. "Stat 1 value", "Page title", "Brand"); values replace the placeholder text. ' +
          'Use whenever the user specified exact copy (names, numbers, labels).',
      })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      // Coerce x/y to numbers — the LLM occasionally passes them as strings
      // (e.g. "100"), and string + number = string concatenation inside
      // buildWireframe (e.g. "100" + 24 = "10024"). This caused the entire
      // wireframe to render at insane coordinates like (10024, 10016).
      const x = typeof params.x === 'number' ? params.x : Number(params.x) || 100;
      const y = typeof params.y === 'number' ? params.y : Number(params.y) || 100;
      const wf = buildWireframe(params.template, x, y);
      if (params.fidelity === 'lofi') {
        applyLofiFidelity(wf.shapes);
      }
      // Apply the caller's text overrides (poka-yoke for copy fidelity: the
      // templates ship placeholder values like "$12.4k" — when the user gave
      // exact copy, the agent passes `texts` and the generated screen carries
      // the real content in the SAME call, no follow-up updates needed).
      const appliedTexts = applyTextOverrides(wf.shapes, params.texts);
      const patch: CanvasPatch = {
        op: 'bulk_add',
        shapes: wf.shapes,
        summary: `Generated ${params.template} ${params.fidelity === 'lofi' ? 'low-fi wireframe' : 'screen'} (${wf.shapes.length} shapes${appliedTexts > 0 ? `, ${appliedTexts} text override(s)` : ''})`,
      };
      ctx.applyPatch(patch);
      return {
        content: [
          {
            type: 'text',
            text:
              `Generated ${params.template} wireframe at (${x}, ${y}). ${wf.shapes.length} shapes added. Frame id: ${wf.frameId}.` +
              (appliedTexts > 0
                ? ` Applied ${appliedTexts} text override(s).`
                : params.texts && Object.keys(params.texts).length > 0
                  ? ' NOTE: no text overrides matched any generated layer names — check the key spelling against the layer names above.'
                  : ''),
          },
        ],
        details: { patch, frameId: wf.frameId, count: wf.shapes.length, textsApplied: appliedTexts },
      };
    },
  });

  // =====================================================================
  // MULTI-SCREEN USER FLOWS (research: UX Pilot, Galileo AI)
  // =====================================================================

  const generateUserFlow = defineTool({
    name: 'pen_generate_user_flow',
    label: 'Generate Multi-Screen User Flow',
    description:
      'Generate a connected series of screens representing a user flow. Places 3-4 frames side by side with arrows between them. ' +
      'Flows: onboarding (3 steps: welcome → permissions → done), ecommerce (4 steps: browse → product → cart → checkout), ' +
      'auth (3 steps: login → mfa → home), signup_funnel (4 steps: landing → signup → verify → dashboard). ' +
      'Each screen is a purpose-built wireframe for that flow step; arrows connect them left-to-right.',
    promptSnippet: 'Generate a multi-screen user flow (onboarding, ecommerce, auth, signup).',
    parameters: Type.Object({
      flow: Type.Union(
        [
          Type.Literal('onboarding'),
          Type.Literal('ecommerce'),
          Type.Literal('auth'),
          Type.Literal('signup_funnel'),
        ],
        { description: 'User flow template' },
      ),
      x: Type.Optional(Type.Number({ description: 'Start X (default 80)' })),
      y: Type.Optional(Type.Number({ description: 'Start Y (default 80)' })),
      fidelity: Type.Optional(FidelitySchema),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const x = params.x ?? 80;
      const y = params.y ?? 80;
      const flow = buildUserFlow(params.flow, x, y);
      if (params.fidelity === 'lofi') {
        applyLofiFidelity(flow.shapes);
      }
      const patch: CanvasPatch = {
        op: 'bulk_add',
        shapes: flow.shapes,
        summary: `Generated ${params.flow} user flow (${flow.shapes.length} shapes, ${flow.frameIds.length} screens)`,
      };
      ctx.applyPatch(patch);
      return {
        content: [
          {
            type: 'text',
            text: `Generated ${params.flow} user flow at (${x}, ${y}). ${flow.frameIds.length} screens, ${flow.shapes.length} shapes total.`,
          },
        ],
        details: { patch, frameIds: flow.frameIds, count: flow.shapes.length },
      };
    },
  });

  // =====================================================================
  // DIAGRAM GENERATION (research: Figma AI diagrams)
  // =====================================================================

  const generateDiagram = defineTool({
    name: 'pen_generate_diagram',
    label: 'Generate Diagram',
    description:
      'Generate a flowchart or mind-map diagram from a list of nodes. Nodes can be linked with arrows. ' +
      'Templates: flowchart (top-down boxes with arrows), mindmap (central node with radial children). ' +
      'Pass a list of node labels; the tool computes positions and connectors.',
    promptSnippet: 'Generate a flowchart or mind-map from a list of node labels.',
    parameters: Type.Object({
      template: Type.Union(
        [Type.Literal('flowchart'), Type.Literal('mindmap')],
        { description: 'Diagram template' },
      ),
      nodes: Type.Array(Type.String(), { description: 'Node labels (2-12 nodes)' }),
      x: Type.Optional(Type.Number({ description: 'Diagram X origin (default 200)' })),
      y: Type.Optional(Type.Number({ description: 'Diagram Y origin (default 100)' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const x = params.x ?? 200;
      const y = params.y ?? 100;
      const diagram = buildDiagram(params.template, params.nodes, x, y);
      const patch: CanvasPatch = {
        op: 'bulk_add',
        shapes: diagram.shapes,
        summary: `Generated ${params.template} diagram (${params.nodes.length} nodes, ${diagram.shapes.length} shapes)`,
      };
      ctx.applyPatch(patch);
      return {
        content: [
          {
            type: 'text',
            text: `Generated ${params.template} diagram at (${x}, ${y}). ${params.nodes.length} nodes, ${diagram.shapes.length} total shapes.`,
          },
        ],
        details: { patch, count: diagram.shapes.length },
      };
    },
  });

  // =====================================================================
  // ATTENTION HEATMAP — REMOVED for .pen format purity.
  // pen.dev has no analysis-overlay concept; predictive heatmaps are not
  // part of the .pen ontology. The pen_predict_heatmap tool and the
  // `heatmap` patch op / `HeatmapOverlay` type have been dropped.
  // =====================================================================

  // =====================================================================
  // COPY / TEXT GENERATION (research: Figma AI placeholder content)
  // =====================================================================

  const generateCopy = defineTool({
    name: 'pen_generate_copy',
    label: 'Generate Placeholder Copy',
    description:
      'Generate realistic placeholder copy for a text shape. Variants: heading (short punchy title), ' +
      'subheading (one-sentence subtitle), body (lorem-style paragraph), button (CTA label), caption, microcopy. ' +
      'Updates the text content of an existing text shape in place.',
    promptSnippet: 'Fill a text shape with realistic placeholder copy.',
    parameters: Type.Object({
      shapeId: Type.String({ description: 'ID of the text shape to fill' }),
      variant: Type.Union(
        [
          Type.Literal('heading'),
          Type.Literal('subheading'),
          Type.Literal('body'),
          Type.Literal('button'),
          Type.Literal('caption'),
          Type.Literal('microcopy'),
        ],
        { description: 'Copy variant' },
      ),
      topic: Type.Optional(Type.String({ description: 'Optional topic to anchor the copy (e.g. "project management")' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const shape = ctx.getShapes().find((s) => s.id === params.shapeId);
      if (!shape) {
        return {
          content: [{ type: 'text', text: `Error: no shape with id ${params.shapeId}` }],
          details: { error: 'not_found' },
          isError: true as any,
        };
      }
      const topic = params.topic?.trim() || 'your product';
      const copy = COPY_VARIANTS[params.variant](topic);
      const patch: CanvasPatch = {
        op: 'update',
        shapeId: params.shapeId,
        shape: { text: copy },
        summary: `Filled "${shape.name}" with ${params.variant} copy`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Updated text shape ${params.shapeId} with ${params.variant} copy: "${copy.slice(0, 60)}…"` }],
        details: { patch, copy },
      };
    },
  });

  // =====================================================================
  // DESIGN AUDITING (research: AI design-system audit)
  // =====================================================================

  const auditDesign = defineTool({
    name: 'pen_audit_design',
    label: 'Audit Design Consistency',
    description:
      'Audit the current canvas for design-consistency issues. Returns a textual report covering: ' +
      'color palette drift (too many distinct colors), spacing inconsistencies, ' +
      'font-size proliferation, low-contrast text, and unaligned shapes. ' +
      'Does NOT mutate the canvas — pure analysis. The agent can then act on the findings.',
    promptSnippet: 'Audit the canvas for design-consistency issues (read-only).',
    parameters: Type.Object({}),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const shapes = ctx.getShapes();
      const tokens = ctx.getTokens();
      const findings: string[] = [];

      // 1. Color drift
      const colors = new Set<string>();
      for (const s of shapes) {
        colors.add(s.fill.toLowerCase());
        if (s.type === 'text') colors.add(s.textColor.toLowerCase());
      }
      colors.delete('transparent');
      if (colors.size > 8) {
        findings.push(`• Color drift: ${colors.size} distinct colors. Consider consolidating to ≤ 6 + binding to tokens.`);
      } else {
        findings.push(`• Color usage: ${colors.size} distinct colors (good).`);
      }

      // 2. Font sizes
      const fontSizes = new Set<number>();
      for (const s of shapes) {
        if (s.type === 'text') fontSizes.add(s.fontSize);
      }
      if (fontSizes.size > 5) {
        findings.push(`• Type scale: ${fontSizes.size} distinct font sizes (consider a 4-5 step scale).`);
      } else {
        findings.push(`• Type scale: ${fontSizes.size} distinct font sizes (good).`);
      }

      // 3. Low-contrast text
      let lowContrast = 0;
      for (const s of shapes) {
        if (s.type === 'text') {
          const ratio = contrastRatio(s.textColor, s.fill);
          if (ratio < 4.5) {
            lowContrast++;
            findings.push(`• Low-contrast text "${(s.text ?? '').slice(0, 30)}…" on fill ${s.fill}: ratio ${Number.isFinite(ratio) ? ratio.toFixed(1) : '?'} (< 4.5 WCAG AA).`);
          }
        }
      }
      if (lowContrast === 0) findings.push('• Text contrast: all text passes WCAG AA (good).');

      // 4. Tokens usage
      const boundCount = shapes.filter((s) => s.tokenBinding && (s.tokenBinding.fillToken || s.tokenBinding.textToken)).length;
      if (tokens.colors.length === 0) {
        findings.push(`• No design tokens defined — consider using pen_generate_palette + pen_apply_palette (bindToTokens=true).`);
      } else {
        findings.push(`• Design tokens: ${tokens.colors.length} color tokens defined; ${boundCount}/${shapes.length} shapes bound.`);
      }

      // 5. Alignment: detect near-misses (shapes that almost align but not quite)
      const xLines = new Map<number, number>();
      for (const s of shapes) {
        const key = Math.round(s.x / 4) * 4;
        xLines.set(key, (xLines.get(key) ?? 0) + 1);
      }
      const misaligned = shapes.filter((s) => {
        const k = Math.round(s.x / 4) * 4;
        return (xLines.get(k) ?? 0) < 2 && (xLines.get(Math.round((s.x + 4) / 4) * 4) ?? 0) >= 2;
      });
      if (misaligned.length > 0) {
        findings.push(`• Possible alignment near-miss: ${misaligned.length} shape(s) within 4px of an alignment grid line.`);
      }

      const report = `Design audit (${shapes.length} shapes, ${tokens.colors.length} tokens):\n${findings.join('\n')}`;
      return {
        content: [{ type: 'text', text: report }],
        details: { findings, colorCount: colors.size, fontSizeCount: fontSizes.size, lowContrastCount: lowContrast },
      };
    },
  });

  // =====================================================================
  // PHASE 1a: TOKEN BINDING (4 tools)
  // Closes the half-wired tokenBinding loop — apply_palette's bindToTokens
  // flag created tokens without binding them; these tools let the agent
  // explicitly bind/unbind shapes to tokens.
  // =====================================================================

  const bindShapeToToken = defineTool({
    name: 'pen_bind_variable',
    label: 'Bind Variable',
    description:
      'Bind a node property (fill, stroke, or textColor) to a named variable. ' +
      'When the variable\'s value changes, the bound property auto-updates. ' +
      'Use this after pen_set_variables or pen_apply_palette to create a live link.',
    promptSnippet: 'Bind a node property to a variable (live link).',
    promptGuidelines: [
      'The variableId must match a key in the document\'s color variables. Call pen_list_variables to see available keys.',
      'Binding fill: the node\'s fill is set to the variable value immediately and re-computed on variable changes.',
    ],
    parameters: Type.Object({
      nodeId: Type.String({ description: 'ID of the node to bind (legacy alias: shapeId)' }),
      variableId: Type.String({ description: 'Variable key (e.g. "bg.primary", "accent") — legacy alias: tokenKey' }),
      property: Type.Union(
        [Type.Literal('fill'), Type.Literal('stroke'), Type.Literal('textColor')],
        { description: 'Which property to bind (Figma scopes: fills, strokes, characters)' },
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const p = params as any;
      const nodeId: string = params.nodeId ?? p.shapeId;
      const variableId: string = params.variableId ?? p.tokenKey;
      const shape = ctx.getShapes().find((s) => s.id === nodeId);
      if (!shape) {
        return { content: [{ type: 'text', text: `Error: no shape with id ${nodeId}` }], details: { error: 'not_found', shapeId: nodeId }, isError: true as any };
      }
      const token = ctx.getTokens().colors.find((c) => c.key === variableId);
      if (!token) {
        return { content: [{ type: 'text', text: `Error: no color variable with key "${variableId}"` }], details: { error: 'token_not_found', tokenKey: variableId }, isError: true as any };
      }
      const binding = { ...(shape.tokenBinding ?? {}) };
      if (params.property === 'fill') { binding.fillToken = variableId; }
      else if (params.property === 'stroke') { binding.strokeToken = variableId; }
      else { binding.textToken = variableId; }
      const changes: Partial<Shape> = { tokenBinding: binding };
      if (params.property === 'fill') changes.fill = token.value;
      else if (params.property === 'stroke') changes.stroke = token.value;
      else changes.textColor = token.value;
      const patch: CanvasPatch = { op: 'update', shapeId: nodeId, shape: changes, summary: `Bound ${params.property} to variable "${variableId}"` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Bound ${shape.name}.${params.property} to variable "${variableId}" (${token.value}).` }], details: { shapeId: nodeId, tokenKey: variableId, property: params.property, patch } };
    },
  });

  const unbindShape = defineTool({
    name: 'pen_unbind_variable',
    label: 'Unbind Variable',
    description: 'Remove a variable binding from a node property. The node keeps its current color value but will no longer auto-update when the variable changes.',
    promptSnippet: 'Remove a variable binding from a node.',
    parameters: Type.Object({
      nodeId: Type.String({ description: 'ID of the node to unbind (legacy alias: shapeId)' }),
      property: Type.Union(
        [Type.Literal('fill'), Type.Literal('stroke'), Type.Literal('textColor')],
        { description: 'Which property to unbind (Figma scopes: fills, strokes, characters)' },
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const p = params as any;
      const nodeId: string = params.nodeId ?? p.shapeId;
      const shape = ctx.getShapes().find((s) => s.id === nodeId);
      if (!shape) {
        return { content: [{ type: 'text', text: `Error: no shape with id ${nodeId}` }], details: { error: 'not_found' }, isError: true as any };
      }
      const binding = { ...(shape.tokenBinding ?? {}) };
      // Bake in the current resolved value before removing the binding, so the
      // node retains its last-themed appearance (doesn't revert to the
      // pre-binding fill).
      const changes: Partial<Shape> = {};
      if (params.property === 'fill') { delete binding.fillToken; changes.fill = shape.fill; }
      else if (params.property === 'stroke') { delete binding.strokeToken; changes.stroke = shape.stroke; }
      else { delete binding.textToken; changes.textColor = shape.textColor; }
      changes.tokenBinding = Object.keys(binding).length === 0 ? null : binding;
      const patch: CanvasPatch = { op: 'update', shapeId: nodeId, shape: changes, summary: `Unbound ${params.property} from variable` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Unbound ${shape.name}.${params.property}.` }], details: { shapeId: nodeId, property: params.property, patch } };
    },
  });

  const listTokens = defineTool({
    name: 'pen_list_variables',
    label: 'List Variables',
    description: 'List all variables (colors + text styles) currently defined on the canvas. Read-only — does not modify the canvas. Use this before pen_bind_variable to see available variable keys.',
    promptSnippet: 'List all variables (colors + text styles).',
    parameters: Type.Object({}),
    async execute(toolCallId) {
      const tokens = ctx.getTokens();
      const colorLines = tokens.colors.map((c) => `  ${c.key.padEnd(20)} ${c.value}  (${c.name})`);
      const textLines = tokens.textStyles.map((t) => `  ${t.key.padEnd(20)} ${t.fontSize}px/${t.fontWeight}  ${t.color}  (${t.name})`);
      const report = `=== Color Tokens (${tokens.colors.length}) ===\n${colorLines.join('\n') || '  (none)'}\n\n=== Text Style Tokens (${tokens.textStyles.length}) ===\n${textLines.join('\n') || '  (none)'}`;
      return { content: [{ type: 'text', text: report }], details: { colorCount: tokens.colors.length, textStyleCount: tokens.textStyles.length } };
    },
  });

  const applyToken = defineTool({
    name: 'pen_apply_variable',
    label: 'Apply Variable to Nodes',
    description: 'Apply a variable\'s value to one or more nodes. Optionally also bind the nodes to the variable (live link). ' +
      'This is the batch version of pen_bind_variable.',
    promptSnippet: 'Apply a variable value to multiple nodes at once.',
    parameters: Type.Object({
      nodeIds: Type.Array(Type.String(), { description: 'Node IDs to apply the variable to (legacy alias: shapeIds)' }),
      variableId: Type.String({ description: 'Variable key to apply — legacy alias: tokenKey' }),
      property: Type.Union(
        [Type.Literal('fill'), Type.Literal('stroke'), Type.Literal('textColor')],
        { description: 'Which property to set (Figma scopes: fills, strokes, characters)' },
      ),
      bind: Type.Optional(Type.Boolean({ description: 'If true, also create a live binding (default false)' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const p = params as any;
      const variableId: string = params.variableId ?? p.tokenKey;
      const nodeIds: string[] = Array.isArray(params.nodeIds)
        ? params.nodeIds
        : (Array.isArray(p.shapeIds) ? p.shapeIds : []);
      const token = ctx.getTokens().colors.find((c) => c.key === variableId);
      if (!token) {
        return { content: [{ type: 'text', text: `Error: no color variable with key "${variableId}"` }], details: { error: 'token_not_found' }, isError: true as any };
      }
      const shapes = ctx.getShapes();
      const updates = nodeIds
        .map((id) => shapes.find((s) => s.id === id))
        .filter((s): s is Shape => !!s)
        .map((s) => {
          const changes: Partial<Shape> = {};
          if (params.property === 'fill') changes.fill = token.value;
          else if (params.property === 'stroke') changes.stroke = token.value;
          else changes.textColor = token.value;
          if (params.bind) {
            const binding = { ...(s.tokenBinding ?? {}) };
            if (params.property === 'fill') binding.fillToken = variableId;
            else if (params.property === 'stroke') binding.strokeToken = variableId;
            else binding.textToken = variableId;
            changes.tokenBinding = binding;
          }
          return { id: s.id, changes };
        });
      if (updates.length === 0) {
        return { content: [{ type: 'text', text: 'No matching shapes found.' }], details: { error: 'not_found' }, isError: true as any };
      }
      const patch: CanvasPatch = { op: 'update_many', updates, summary: `Applied variable "${variableId}" to ${updates.length} node(s)${params.bind ? ' (bound)' : ''}` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Applied variable "${variableId}" (${token.value}) to ${updates.length} node(s).` }], details: { count: updates.length, tokenKey: variableId, patch } };
    },
  });

  // =====================================================================
  // PHASE 1b: LOCK & VISIBILITY (2 tools)
  // The `locked` and `visible` fields exist on Shape but no tool touched
  // them. These tools make them agent-accessible.
  // =====================================================================

  const setLocked = defineTool({
    name: 'pen_set_locked',
    label: 'Lock / Unlock Shapes',
    description: 'Lock or unlock one or more shapes. Locked shapes cannot be moved or resized by direct manipulation (but can still be updated via tools).',
    promptSnippet: 'Lock or unlock shapes.',
    parameters: Type.Object({
      shapeIds: Type.Array(Type.String(), { description: 'Shape IDs to lock/unlock' }),
      locked: Type.Boolean({ description: 'true to lock, false to unlock' }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const updates = params.shapeIds.map((id) => ({ id, changes: { locked: params.locked } as Partial<Shape> }));
      const patch: CanvasPatch = { op: 'update_many', updates, summary: `${params.locked ? 'Locked' : 'Unlocked'} ${params.shapeIds.length} shape(s)` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `${params.locked ? 'Locked' : 'Unlocked'} ${params.shapeIds.length} shape(s).` }], details: { count: params.shapeIds.length, locked: params.locked, patch } };
    },
  });

  const setVisible = defineTool({
    name: 'pen_set_visible',
    label: 'Show / Hide Shapes',
    description: 'Show or hide one or more shapes. Hidden shapes are not rendered but remain in the document. Useful for creating alternative states or simplifying a complex canvas.',
    promptSnippet: 'Show or hide shapes.',
    parameters: Type.Object({
      shapeIds: Type.Array(Type.String(), { description: 'Shape IDs to show/hide' }),
      visible: Type.Boolean({ description: 'true to show, false to hide' }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const updates = params.shapeIds.map((id) => ({ id, changes: { visible: params.visible } as Partial<Shape> }));
      const patch: CanvasPatch = { op: 'update_many', updates, summary: `${params.visible ? 'Showed' : 'Hid'} ${params.shapeIds.length} shape(s)` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `${params.visible ? 'Showed' : 'Hid'} ${params.shapeIds.length} shape(s).` }], details: { count: params.shapeIds.length, visible: params.visible, patch } };
    },
  });

  // =====================================================================
  // PHASE 1c: Z-ORDER (4 tools)
  // Currently zIndex is only set at creation or via organize_layers.
  // These tools let the agent reorder individual shapes.
  // =====================================================================

  const bringToFront = defineTool({
    name: 'pen_bring_to_front',
    label: 'Bring to Front',
    description: 'Move one or more shapes to the top of the z-order (above all other shapes).',
    promptSnippet: 'Bring shapes to the front of the z-order.',
    parameters: Type.Object({
      shapeIds: Type.Array(Type.String(), { description: 'Shape IDs to bring to front' }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const patch: CanvasPatch = { op: 'zorder', shapeIds: params.shapeIds, zorderKind: 'front', summary: `Brought ${params.shapeIds.length} shape(s) to front` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Brought ${params.shapeIds.length} shape(s) to front.` }], details: { count: params.shapeIds.length, patch } };
    },
  });

  const sendToBack = defineTool({
    name: 'pen_send_to_back',
    label: 'Send to Back',
    description: 'Move one or more shapes to the bottom of the z-order (below all other shapes).',
    promptSnippet: 'Send shapes to the back of the z-order.',
    parameters: Type.Object({
      shapeIds: Type.Array(Type.String(), { description: 'Shape IDs to send to back' }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const patch: CanvasPatch = { op: 'zorder', shapeIds: params.shapeIds, zorderKind: 'back', summary: `Sent ${params.shapeIds.length} shape(s) to back` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Sent ${params.shapeIds.length} shape(s) to back.` }], details: { count: params.shapeIds.length, patch } };
    },
  });

  const moveForward = defineTool({
    name: 'pen_move_forward',
    label: 'Move Forward',
    description: 'Move a shape one level forward (above its current neighbor).',
    promptSnippet: 'Move a shape one level up in the z-order.',
    parameters: Type.Object({
      shapeId: Type.String({ description: 'Shape ID to move forward' }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const patch: CanvasPatch = { op: 'zorder', shapeIds: [params.shapeId], zorderKind: 'forward', summary: 'Moved shape forward' };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: 'Moved shape forward.' }], details: { shapeId: params.shapeId, patch } };
    },
  });

  const moveBackward = defineTool({
    name: 'pen_move_backward',
    label: 'Move Backward',
    description: 'Move a shape one level backward (below its current neighbor).',
    promptSnippet: 'Move a shape one level down in the z-order.',
    parameters: Type.Object({
      shapeId: Type.String({ description: 'Shape ID to move backward' }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const patch: CanvasPatch = { op: 'zorder', shapeIds: [params.shapeId], zorderKind: 'backward', summary: 'Moved shape backward' };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: 'Moved shape backward.' }], details: { shapeId: params.shapeId, patch } };
    },
  });

  const reorderShape = defineTool({
    name: 'pen_reorder_shape',
    label: 'Reorder Shape',
    description: 'Move a shape to a specific z-index position. Other shapes shift to make room.',
    promptSnippet: 'Move a shape to a specific z-index.',
    parameters: Type.Object({
      shapeId: Type.String({ description: 'Shape ID to reorder' }),
      zIndex: Type.Number({ description: 'Target z-index (0 = bottom)' }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const patch: CanvasPatch = { op: 'reorder', shapeId: params.shapeId, zIndex: params.zIndex, summary: `Moved shape to z-index ${params.zIndex}` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Moved shape to z-index ${params.zIndex}.` }], details: { shapeId: params.shapeId, zIndex: params.zIndex, patch } };
    },
  });

  // =====================================================================
  // PHASE 2a: UNDO / REDO (2 tools)
  // Emits special 'undo' / 'redo' patches. The canvas store intercepts
  // these (it maintains the undo/redo stacks client-side). The server-side
  // patch applier is a no-op for these ops.
  // =====================================================================

  const undoCanvas = defineTool({
    name: 'pen_undo',
    label: 'Undo',
    description: 'Undo the last canvas change. Can be called multiple times to undo further back. ' +
      'NOTE: this only affects the local (client) canvas state — it does not reverse agent tool calls in the chat history.',
    promptSnippet: 'Undo the last canvas change.',
    parameters: Type.Object({}),
    async execute(toolCallId) {
      const patch: CanvasPatch = { op: 'undo' as any, summary: 'Undo' };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: 'Undid the last canvas change.' }], details: { patch } };
    },
  });

  const redoCanvas = defineTool({
    name: 'pen_redo',
    label: 'Redo',
    description: 'Redo a previously undone canvas change. Can be called multiple times.',
    promptSnippet: 'Redo a previously undone change.',
    parameters: Type.Object({}),
    async execute(toolCallId) {
      const patch: CanvasPatch = { op: 'redo' as any, summary: 'Redo' };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: 'Redid the last undone change.' }], details: { patch } };
    },
  });

  // =====================================================================
  // PHASE 2b: EXPORT (4 tools)
  // Serialize the canvas to JSON, SVG, or code. The agent returns the
  // exported content as text in the tool result — the user can copy it
  // from the chat.
  // =====================================================================

  const exportJson = defineTool({
    name: 'pen_export_json',
    label: 'Export as JSON',
    description: 'Export the full canvas document as a JSON string. Includes all shapes, tokens, background, and viewport. Useful for backup or migration.',
    promptSnippet: 'Export the canvas as JSON.',
    parameters: Type.Object({}),
    async execute(toolCallId) {
      const doc = ctx.getDocument?.() ?? { shapes: ctx.getShapes(), tokens: ctx.getTokens() };
      const json = JSON.stringify(doc, null, 2);
      return { content: [{ type: 'text', text: `Canvas JSON (${json.length} chars):\n\`\`\`json\n${json.slice(0, 4000)}${json.length > 4000 ? '\n... (truncated, see full output in details)' : ''}\n\`\`\`` }], details: { json, charCount: json.length } };
    },
  });

  const exportSvg = defineTool({
    name: 'pen_export_svg',
    label: 'Export as SVG',
    description: 'Export the canvas as an SVG string. Each shape is rendered as its SVG element. Useful for embedding in documents or converting to PNG.',
    promptSnippet: 'Export the canvas as SVG.',
    parameters: Type.Object({
      frameId: Type.Optional(Type.String({ description: 'If provided, export only shapes inside this frame' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      // Delegate to the shared client export module (pure functions — safe on
      // the server). This keeps the agent export identical to the UI export,
      // including gradient/shadow/opacity fidelity, star/polygon nodes, and
      // tree-based frame filtering (bbox-only filtering dropped children that
      // crossed the frame edge).
      const { exportSvgWithSize } = await import('../canvas/export');
      const withSize = exportSvgWithSize(ctx.getShapes(), { frameId: params.frameId });
      if (!withSize) {
        return { content: [{ type: 'text', text: 'No shapes to export.' }], details: { error: 'empty' } };
      }
      const { svg, w, h, count } = withSize;
      return { content: [{ type: 'text', text: `SVG exported (${w}×${h}, ${count} shapes). Length: ${svg.length} chars.\n\`\`\`svg\n${svg.slice(0, 4000)}${svg.length > 4000 ? '\n... (truncated)' : ''}\n\`\`\`` }], details: { svg, width: w, height: h, shapeCount: count } };
    },
  });

  const exportPng = defineTool({
    name: 'pen_export_png',
    label: 'Export as PNG (data URL)',
    description: 'Export the canvas as an SVG data URL that can be used in <img> tags or downloaded. ' +
      'True PNG rasterization requires a browser; this tool returns an SVG data URL which any browser can render and convert to PNG.',
    promptSnippet: 'Export the canvas as an image data URL.',
    parameters: Type.Object({
      frameId: Type.Optional(Type.String({ description: 'If provided, export only shapes inside this frame' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const allShapes = ctx.getShapes();
      let shapes = allShapes;
      if (params.frameId) {
        const frame = allShapes.find((s) => s.id === params.frameId);
        if (frame) {
          shapes = allShapes.filter((s) =>
            s.id !== params.frameId &&
            s.x >= frame.x && s.y >= frame.y &&
            s.x + s.width <= frame.x + frame.width &&
            s.y + s.height <= frame.y + frame.height,
          );
        }
      }
      if (shapes.length === 0) {
        return { content: [{ type: 'text', text: 'No shapes to export.' }], details: { error: 'empty' } };
      }
      const minX = Math.min(...shapes.map((s) => s.x));
      const minY = Math.min(...shapes.map((s) => s.y));
      const maxX = Math.max(...shapes.map((s) => s.x + s.width));
      const maxY = Math.max(...shapes.map((s) => s.y + s.height));
      const w = maxX - minX;
      const h = maxY - minY;
      const els = shapes.map((s) => {
        const rx = s.x - minX;
        const ry = s.y - minY;
        const stroke = s.strokeWidth > 0 ? ` stroke="${s.stroke}" stroke-width="${s.strokeWidth}"` : '';
        switch (s.type) {
          case 'rectangle': case 'frame':
            return `<rect x="${rx}" y="${ry}" width="${s.width}" height="${s.height}" rx="${s.radius}" fill="${s.fill}"${stroke}/>`;
          case 'ellipse':
            return `<ellipse cx="${rx + s.width / 2}" cy="${ry + s.height / 2}" rx="${s.width / 2}" ry="${s.height / 2}" fill="${s.fill}"${stroke}/>`;
          case 'line':
            return `<line x1="${rx}" y1="${ry}" x2="${rx + s.width}" y2="${ry + s.height}" stroke="${s.fill}" stroke-width="${Math.max(2, s.strokeWidth)}" stroke-linecap="round"/>`;
          case 'text':
            return `<text x="${rx}" y="${ry + s.fontSize}" font-size="${s.fontSize}" fill="${s.textColor}" font-family="Inter, sans-serif">${escapeXml(s.text ?? '')}</text>`;
          default: return '';
        }
      }).join('');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${els}</svg>`;
      const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
      return { content: [{ type: 'text', text: `Exported as SVG data URL (${w}×${h}, ${shapes.length} shapes). Length: ${dataUrl.length} chars. Use in an <img src="..."> tag.` }], details: { dataUrl, width: w, height: h, shapeCount: shapes.length } };
    },
  });

  // ---- Shared helpers for the Figma-MCP-aligned read/serialize tools -------

  /// Find a subtree by node id in the resolver's tree (pre-order).
  function findTreeNode(tree: ResolvedTreeNode[], id: string): ResolvedTreeNode | null {
    for (const n of tree) {
      if (n.layer.id === id) return n;
      const found = findTreeNode(n.children, id);
      if (found) return found;
    }
    return null;
  }

  /// Flatten a resolved tree (root included, depth-first).
  function flattenTree(tree: ResolvedTreeNode[]): Shape[] {
    const out: Shape[] = [];
    const walk = (nodes: ResolvedTreeNode[]) => {
      for (const n of nodes) {
        out.push(n.layer);
        walk(n.children);
      }
    };
    walk(tree);
    return out;
  }

  /// Recursively count nodes in a .pen children array.
  function countTreeNodes(children: PenChild[]): number {
    let count = 0;
    const walk = (nodes: PenChild[]) => {
      for (const n of nodes) {
        count++;
        const kids = (n as { children?: PenChild[] }).children;
        if (Array.isArray(kids)) walk(kids);
      }
    };
    walk(children);
    return count;
  }

  /// Collect a node + its strict descendants from a flat layer list.
  function subtreeLayers(layers: Shape[], rootId: string): Shape[] {
    const root = layers.find((s) => s.id === rootId);
    if (!root) return [];
    const byParent = new Map<string, Shape[]>();
    for (const s of layers) {
      const p = s.parentId ?? null;
      if (p) {
        const list = byParent.get(p) ?? [];
        list.push(s);
        byParent.set(p, list);
      }
    }
    const out: Shape[] = [root];
    const queue = [rootId];
    const seen = new Set([rootId]);
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const child of byParent.get(id) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        out.push(child);
        queue.push(child.id);
      }
    }
    return out;
  }

  /// Sanitize a variable key into a CSS custom-property identifier fragment.
  function varKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9-]/g, '-');
  }

  const copyAsCode = defineTool({
    name: 'pen_copy_as_code',
    label: 'Copy as Code (v2 — tree serializer)',
    description: 'Generate HTML + Tailwind CSS code from the canvas shapes. Useful for handoff to developers. ' +
      'v2 (spec §5.3): consumes the .pen tree — auto-layout containers become REAL nested flexbox ' +
      '(not flat absolutes); layout:none containers become relative containers with absolutely-positioned ' +
      'children; every element carries data-name/data-node-id; token-bound fills emit var(--acv-key, fallback). ' +
      'Supports: html (standalone HTML), react (JSX component), tailwind (Tailwind classes).',
    promptSnippet: 'Generate HTML/React/Tailwind code from the canvas (nested flex output).',
    parameters: Type.Object({
      frameId: Type.Optional(Type.String({ description: 'If provided, export only shapes inside this frame' })),
      framework: Type.Union(
        [Type.Literal('html'), Type.Literal('react'), Type.Literal('tailwind')],
        { description: 'Output format' },
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const doc = ctx.getDocument?.();
      let input: ResolvedTreeNode[] | Shape[];
      if (doc) {
        const { tree, layers } = resolvePenTreeDetailed(doc);
        if (params.frameId) {
          const subtree = findTreeNode(tree, params.frameId);
          if (subtree) {
            input = [subtree];
          } else {
            // Fallback: subtree collection from the flat layers (matches the
            // legacy export filter semantics).
            const scoped = subtreeLayers(layers, params.frameId);
            if (scoped.length === 0) {
              return { content: [{ type: 'text', text: 'No shapes to export.' }], details: { error: 'empty' } };
            }
            input = scoped;
          }
        } else {
          input = tree;
        }
      } else {
        // No document snapshot — degrade to the flat layer view.
        const layers = ctx.getShapes();
        input = params.frameId ? subtreeLayers(layers, params.frameId) : layers;
      }
      const shapeCount = input.length;
      if (shapeCount === 0) {
        return { content: [{ type: 'text', text: 'No shapes to export.' }], details: { error: 'empty' } };
      }
      const code = serializeNodes(input, { framework: params.framework, rootName: 'CanvasExport' });
      return { content: [{ type: 'text', text: `Generated ${params.framework} code (${shapeCount} nodes, nested-flex serializer v2):\n\`\`\`${params.framework === 'react' ? 'tsx' : 'html'}\n${code}\n\`\`\`` }], details: { code, framework: params.framework, shapeCount } };
    },
  });

  // =====================================================================
  // PHASE 3 (spec §5.2): FIGMA-MCP-ALIGNED TOOLS
  //
  // Read-side tools adopt the exact verb names of Figma's Dev Mode MCP
  // Server (get_metadata / get_design_context / get_variable_defs) under
  // our existing pen_ namespace, plus the code→canvas construction
  // primitive pen_insert_html (Figma analog: generate_figma_design) and the
  // measured-bounds writeback pen_bake_layout.
  //
  // pen_get_computed / pen_get_screenshot (M2-c) are CLIENT ROUND-TRIP
  // tools: they emit a SyncEvent through the per-turn plugin event sink,
  // block on the client-roundtrip pending map (≤2s), and FALL BACK to
  // resolver data / server-side rendering when no client answers — the
  // agent loop can never hang. `hasSink()` short-circuits the wait when
  // we're not even inside an agent turn (tests, headless calls).
  // =====================================================================

  /// Build a resolver-data ComputedResult for one shape (fallback when the
  /// client is offline / a node is unmounted). Values are the resolver's
  /// predictions, not real layout — flagged measured:false.
  function resolverComputedFallback(s: Shape, properties?: string[]): ComputedResult {
    const computed: Record<string, string> = {
      display: s.autoLayout ? 'flex' : 'block',
      position: 'absolute',
      width: `${Math.round(s.width)}px`,
      height: `${Math.round(s.height)}px`,
      backgroundColor: s.fill ?? 'rgba(0, 0, 0, 0)',
      color: (s as Shape & { textColor?: string }).textColor ?? s.fill ?? 'inherit',
      fontFamily: (s as Shape & { fontFamily?: string }).fontFamily ?? 'Inter, system-ui, sans-serif',
      fontSize: `${(s as Shape & { fontSize?: number }).fontSize ?? 16}px`,
      fontWeight: String((s as Shape & { fontWeight?: number }).fontWeight ?? 400),
      opacity: String(s.opacity ?? 1),
      zIndex: String(s.zIndex ?? 0),
      overflow: (s as Shape & { clip?: boolean }).clip ? 'hidden' : 'visible',
      visibility: s.visible === false ? 'hidden' : 'visible',
    };
    if (s.autoLayout) {
      computed.flexDirection = s.autoLayout.direction === 'vertical' ? 'column' : 'row';
      computed.gap = `${s.autoLayout.gap ?? 0}px`;
      computed.alignItems = s.autoLayout.alignY ?? 'start';
      computed.justifyContent = s.autoLayout.alignX ?? 'start';
    }
    if (s.radius != null) computed.borderRadius = `${s.radius}px`;
    if (properties && properties.length > 0) {
      const keep = new Set(properties);
      for (const k of Object.keys(computed)) if (!keep.has(k)) delete computed[k];
    }
    return {
      id: s.id,
      rect: { x: Math.round(s.x), y: Math.round(s.y), width: Math.round(s.width), height: Math.round(s.height) },
      canvasRect: { x: Math.round(s.x), y: Math.round(s.y), width: Math.round(s.width), height: Math.round(s.height) },
      computed,
      measured: false as const,
    };
  }

  /// Ask the connected client for a real screenshot (agent:screenshot_request
  /// round-trip). Null when no sink / no client answered in time.
  async function requestClientScreenshot(
    toolCallId: string,
    nodeId: string | undefined,
    scale: number | undefined,
    timeoutMs: number,
  ): Promise<ScreenshotResult | null> {
    if (!hasSink()) return null; // outside an agent turn — no client can answer
    return awaitClientResponse<ScreenshotResult>(
      toolCallId,
      () => emitEvent({ type: 'agent:screenshot_request', toolCallId, ...(nodeId ? { nodeId } : {}), ...(scale ? { scale } : {}) }),
      timeoutMs,
    );
  }

  const insertHtml = defineTool({
    name: 'pen_insert_html',
    label: 'Insert HTML as Design Nodes',
    description: 'Insert an HTML fragment (inline styles only) as design nodes under a parent. ' +
      'Block containers become frames (auto-layout when the style is flex); headings/paragraphs/spans ' +
      'become text nodes; img becomes image fills. Sanitized server-side (whitelisted tags/attributes, ' +
      'URL schemes). Prefer this over repeated pen_create_node for composite UI — one call builds a ' +
      'whole card, form, or nav bar. Emits ONE bulk_add patch.',
    promptSnippet: 'Insert an HTML fragment as a .pen subtree (one call, composite UI).',
    parameters: Type.Object({
      html: Type.String({ description: 'HTML fragment. Inline styles only (class-based CSS is not parsed in v1). Whitelisted tags: div span p h1-h6 ul ol li img button label input textarea form a section header footer nav main hr br strong em' }),
      parentId: Type.Optional(Type.String({ description: 'Parent node id (frame/group/page). Default: canvas root' })),
      x: Type.Optional(Type.Number({ description: 'X position of the fragment root (default 0)' })),
      y: Type.Optional(Type.Number({ description: 'Y position of the fragment root (default 0)' })),
      namePrefix: Type.Optional(Type.String({ description: 'Prefix for generated layer names (default "html")' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const html = (params.html ?? '').trim();
      if (!html) {
        return { content: [{ type: 'text', text: 'Error: html parameter is empty.' }], details: { error: 'empty_html' }, isError: true as any };
      }
      // Verify the parent exists (default root) — page ids count too. The
      // resolved layer list already covers every tree node (the resolver
      // flattens the whole .pen tree), so `inLayers` subsumes a tree search.
      const parentId = params.parentId ?? null;
      if (parentId) {
        const doc = ctx.getDocument?.();
        const inLayers = ctx.getShapes().some((s) => s.id === parentId);
        const pageMatch = (doc?.pages ?? []).some((p) => p.id === parentId);
        if (!inLayers && !pageMatch) {
          return {
            content: [{ type: 'text', text: `Error: no node with id "${parentId}" — cannot insert. Call pen_get_metadata (no nodeId) to see the page list, then pass a nodeId for the sparse tree.` }],
            details: { error: 'unknown_parent', parentId },
            isError: true as any,
          };
        }
      }
      const fragment = parseHtmlFragment(html);
      const prefix = (params.namePrefix ?? '').trim() || 'html';
      const { nodes, stats } = htmlToPenTreeDetailed(fragment, { namePrefix: prefix });
      if (nodes.length === 0) {
        return { content: [{ type: 'text', text: 'Nothing to insert — the fragment produced no nodes (all content was dropped by the sanitizer, e.g. a bare <svg> subtree).' }], details: { error: 'no_nodes', stats } };
      }
      // Root nodes are placed at x/y (multiple roots get a 300px column
      // stride); children keep their relative 0-flow coords — auto-layout
      // computes real placement. Children ride along NESTED inside each
      // root's children array (bulk_add carries nested .pen subtrees).
      const x = typeof params.x === 'number' ? params.x : 0;
      const y = typeof params.y === 'number' ? params.y : 0;
      const shapes = nodes.map((node, i) => ({
        ...node,
        x: x + i * 300,
        y,
        parentId,
      })) as Array<Partial<Shape> & { id: string }>;
      const patch: CanvasPatch = {
        op: 'bulk_add',
        shapes,
        summary: `pen_insert_html: ${stats.nodeCount} node(s) from a ${html.length}-char fragment under ${parentId ?? 'canvas root'}`,
      };
      ctx.applyPatch(patch);
      // Collect created ids (roots + descendants) for the result payload.
      const ids: string[] = [];
      const walk = (ns: PenChild[]) => {
        for (const n of ns) {
          ids.push(n.id);
          const kids = (n as { children?: PenChild[] }).children;
          if (Array.isArray(kids)) walk(kids);
        }
      };
      walk(nodes);
      const typeLines = Object.entries(stats.typeCounts).map(([t, c]) => `${t}×${c}`).join(', ');
      const skippedNote = stats.skippedSvg > 0 ? ` Skipped ${stats.skippedSvg} svg/path element(s) (vector import lands with the mounted-iframe phase).` : '';
      return {
        content: [{ type: 'text', text: `Inserted ${stats.nodeCount} node(s) under ${parentId ?? 'canvas root'}: ${typeLines}.${skippedNote}\nRoot node ids: ${nodes.map((n) => n.id).join(', ')}\nMargins and class-based CSS are not imported (v1 — inline styles only); text sizes are estimates until measured bounds land.` }],
        details: { patch, nodeIds: ids, rootIds: nodes.map((n) => n.id), typeCounts: stats.typeCounts, skipped: stats.skippedSvg, nodeCount: stats.nodeCount },
      };
    },
  });

  const getMetadata = defineTool({
    name: 'pen_get_metadata',
    label: 'Get Canvas Metadata (sparse tree)',
    description: 'Read canvas structure. With nodeId: sparse tree of that subtree — ' +
      'one line per node: id, name, type, x, y, width, height. Without nodeId (or unknown id): ' +
      'the page list (id + name). Always call this before heavier reads.',
    promptSnippet: 'Navigate the canvas: page list by default, sparse subtree tree with a nodeId.',
    parameters: Type.Object({
      nodeId: Type.Optional(Type.String({ description: 'Node id (or page id) to read. Omit for the page list.' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const doc = ctx.getDocument?.();
      const layers = ctx.getShapes();
      const pages = doc?.pages ?? null;

      const pageListLines = (note?: string): string => {
        const lines: string[] = [];
        if (pages && pages.length > 0) {
          pages.forEach((p, i) => {
            const active = i === (doc?.activePageIndex ?? -1) ? ' *active*' : '';
            lines.push(`page ${i}: ${p.id} — "${p.name}" (${countTreeNodes(p.children ?? [])} nodes)${active}`);
          });
        } else {
          lines.push(`page 0: ${doc?.id ?? 'page-1'} — "${doc?.name ?? 'Page 1'}" (${countTreeNodes(doc?.children ?? [])} nodes)`);
        }
        return (note ? `${note}\n` : '') + lines.join('\n') + '\nPass a nodeId (or page id) for the sparse tree.';
      };

      if (!params.nodeId) {
        return { content: [{ type: 'text', text: pageListLines() }], details: { mode: 'page_list' } };
      }

      // Page id? Active page → tree of roots; inactive page → page list + hint.
      const pageIdx = pages ? pages.findIndex((p) => p.id === params.nodeId) : -1;
      if (pageIdx !== -1) {
        if (pageIdx === (doc?.activePageIndex ?? -1)) {
          // Fall through to the tree walk below using roots (parentId null).
        } else {
          return { content: [{ type: 'text', text: pageListLines(`page "${pages![pageIdx].name}" is not the active page — switch to it first (pen_set_active_page).`) }], details: { mode: 'page_list', note: 'inactive_page' } };
        }
      }

      const target = layers.find((s) => s.id === params.nodeId);
      if (!target) {
        // Figma MCP recovery behavior: unknown id → page list, never an error dead-end.
        return { content: [{ type: 'text', text: pageListLines(`nodeId "${params.nodeId}" not found — showing the page list.`) }], details: { mode: 'page_list', note: 'unknown_node_id' } };
      }

      // Sparse indented tree — ONE LINE PER NODE, capped at 400 lines.
      const byParent = new Map<string, Shape[]>();
      const byId = new Map<string, Shape>();
      for (const s of layers) {
        byId.set(s.id, s);
        const p = s.parentId ?? null;
        if (p) {
          const list = byParent.get(p) ?? [];
          list.push(s);
          byParent.set(p, list);
        }
      }
      const lines: string[] = [];
      let truncated = false;
      const MAX_LINES = 400;
      const walk = (id: string, depth: number) => {
        if (lines.length >= MAX_LINES) {
          truncated = true;
          return;
        }
        const s = byId.get(id);
        if (!s) return;
        lines.push(`${'  '.repeat(depth)}${s.id} | ${s.name} | ${s.type} | x=${Math.round(s.x)} y=${Math.round(s.y)} w=${Math.round(s.width)} h=${Math.round(s.height)}`);
        const kids = (byParent.get(id) ?? []).slice().sort((a, b) => a.zIndex - b.zIndex);
        for (const kid of kids) walk(kid.id, depth + 1);
      };
      walk(params.nodeId, 0);
      const treeText = lines.join('\n') + (truncated ? `\n…[truncated at ${MAX_LINES} lines — pass a deeper nodeId to see the rest]` : '');
      return {
        content: [{ type: 'text', text: treeText }],
        details: { mode: 'tree', nodeId: params.nodeId, lineCount: lines.length, truncated },
      };
    },
  });

  const getVariableDefs = defineTool({
    name: 'pen_get_variable_defs',
    label: 'Get Variable Definitions',
    description: 'Read the document variable (design token) definitions: names, types, values (or themed values), ' +
      'and CSS code syntax — so generated code binds tokens (var(--acv-<name>)) instead of raw hex. ' +
      'Also lists the derived text styles. v1: definitions are document-level (nodeId accepted for future scoping).',
    promptSnippet: 'Read design-token variable definitions with code syntax for var() binding.',
    parameters: Type.Object({
      nodeId: Type.Optional(Type.String({ description: 'Selection node id (v1: definitions are document-level; reserved for scoped reads)' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const doc = ctx.getDocument?.();
      const variables = doc?.variables ?? {};
      const tokens = ctx.getTokens();
      const variablesOut = Object.entries(variables).map(([name, def]) => {
        const isThemed = Array.isArray(def.value);
        return {
          name,
          type: def.type,
          ...(isThemed
            ? { themedValues: (def.value as Array<{ value: unknown; theme?: unknown }>).map((tv) => ({ value: tv.value, theme: tv.theme })) }
            : { value: (def as { value: unknown }).value }),
          codeSyntax: `var(--acv-${varKey(name)})`,
        };
      });
      const textStylesOut = (tokens.textStyles ?? []).map((t) => ({
        name: t.name,
        type: 'textStyle' as const,
        fontSize: t.fontSize,
        fontWeight: t.fontWeight,
        lineHeight: t.lineHeight,
        color: t.color,
        codeSyntax: `var(--acv-${varKey(t.key)})`,
      }));
      const varLines = variablesOut.length > 0
        ? variablesOut.map((v) => `  ${v.name} | ${v.type} | ${'value' in v ? String(v.value) : `${(v as { themedValues: unknown[] }).themedValues.length} themed values`} | ${v.codeSyntax}`)
        : ['  (none — define tokens with pen_set_variable)'];
      const styleLines = textStylesOut.length > 0
        ? textStylesOut.map((t) => `  ${t.name} | fontSize=${t.fontSize} fontWeight=${t.fontWeight} lineHeight=${t.lineHeight} color=${t.color} | ${t.codeSyntax}`)
        : ['  (none)'];
      const text = `VARIABLES (${variablesOut.length}):\n${varLines.join('\n')}\n\nTEXT STYLES (${textStylesOut.length}):\n${styleLines.join('\n')}\n\nBind these in code as var(--acv-<name>) — the serializer emits var(--acv-key, fallback) for token-bound fills.`;
      return { content: [{ type: 'text', text }], details: { variables: variablesOut, textStyles: textStylesOut, nodeId: params.nodeId ?? null, scope: 'document' } };
    },
  });

  const getDesignContext = defineTool({
    name: 'pen_get_design_context',
    label: 'Get Design Context (4-part handoff)',
    description: 'Full design context for a selection: (1) reference code (html/react/tailwind, ' +
      'data-name/data-node-id attrs, var(--token, fallback) values), (2) screenshot, ' +
      '(3) conversion instructions, (4) asset URLs. Scoped to a nodeId — no whole-canvas dumps.',
    promptSnippet: 'Get the 4-part design handoff payload (code + screenshot + instructions + assets) for a node.',
    parameters: Type.Object({
      nodeId: Type.String({ description: 'Node id to read (use pen_get_metadata to find ids)' }),
      framework: Type.Optional(Type.Union(
        [Type.Literal('html'), Type.Literal('react'), Type.Literal('tailwind')],
        { description: 'Code-part flavor (default react)' },
      )),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const doc = ctx.getDocument?.();
      if (!doc) {
        return { content: [{ type: 'text', text: 'Error: document snapshot unavailable in this context.' }], details: { error: 'no_document' }, isError: true as any };
      }
      const { tree } = resolvePenTreeDetailed(doc);
      const subtree = findTreeNode(tree, params.nodeId);
      if (!subtree) {
        return {
          content: [{ type: 'text', text: `Error: nodeId "${params.nodeId}" not found. Call pen_get_metadata (no nodeId) for the page list, then pass a nodeId for the sparse tree.` }],
          details: { error: 'unknown_node', nodeId: params.nodeId },
          isError: true as any,
        };
      }
      const framework = params.framework ?? 'react';
      const code = serializeNodes([subtree], { framework, rootName: subtree.layer.name || 'Selection' });

      // Part 2 — screenshot: prefer the REAL client capture (round-trip,
      // ≤2s — html-to-image on the live world element, spec §5.4); fall back
      // to the server-side resvg render (images dropped, D8 discipline).
      let screenshotNote = '[screenshot unavailable — no client answered and the server render failed]';
      let screenshotDataUrl: string | undefined;
      let screenshotSize: { width: number; height: number } | undefined;
      const shot = await requestClientScreenshot(
        toolCallId,
        params.nodeId,
        undefined,
        ROUNDTRIP_DEFAULTS.screenshotTimeoutMs,
      );
      if (shot?.dataUrl) {
        screenshotDataUrl = shot.dataUrl;
        screenshotNote = `[real client screenshot (DOM renderer capture @2x) — data URL in details.screenshotDataUrl (${Math.round(screenshotDataUrl.length / 1024)} KB); measured: true]`;
      } else {
        try {
          const layers = flattenTree([subtree]);
          if (layers.length > 0) {
            const minX = Math.min(...layers.map((s) => s.x));
            const minY = Math.min(...layers.map((s) => s.y));
            const maxX = Math.max(...layers.map((s) => s.x + s.width));
            const maxY = Math.max(...layers.map((s) => s.y + s.height));
            const w = Math.max(1, Math.round(maxX - minX));
            const h = Math.max(1, Math.round(maxY - minY));
            const shifted = layers.map((s) => ({ ...s, x: s.x - minX, y: s.y - minY }));
            const { renderCanvasToPng } = await import('../canvas/render-to-png');
            const png = await renderCanvasToPng(shifted, w, h);
            screenshotDataUrl = `data:image/png;base64,${png.toString('base64')}`;
            screenshotSize = { width: w, height: h };
            screenshotNote = `[server-side PNG render ${w}×${h} @2x — data URL in details.screenshotDataUrl (${Math.round(screenshotDataUrl.length / 1024)} KB); measured: false (no client responded)]`;
          }
        } catch {
          // resvg unavailable or render failed — keep the fallback note.
        }
      }

      // Part 3 — conversion instructions (static guidance, Figma-shaped).
      const instructions = [
        'Retarget this reference code to the user\'s stack; it is a structural guide, not a drop-in.',
        'Keep the data-name attributes — they map generated DOM back to design layers for future edits.',
        'Bind tokens, not values: replace raw colors with var(--acv-<name>) where a token binding is shown.',
        'Preserve the flex structure — auto-layout containers are intentional responsive intent.',
        'Absolutely-positioned children (layout:none containers) are pixel placements; keep them absolute.',
      ].join('\n  ');

      // Part 4 — assets: image src URLs in the subtree.
      const assets = flattenTree([subtree])
        .filter((s) => (s.type === 'image' || s.src) && s.src)
        .map((s) => s.src as string);
      const assetLines = assets.length > 0 ? assets.map((a) => `  ${a}`).join('\n') : '  (none)';

      const text =
        `=== 1. REFERENCE CODE (${framework}) ===\n${code}\n\n` +
        `=== 2. SCREENSHOT ===\n${screenshotNote}\n\n` +
        `=== 3. CONVERSION INSTRUCTIONS ===\n  ${instructions}\n\n` +
        `=== 4. ASSETS ===\n${assetLines}`;
      return {
        content: [{ type: 'text', text }],
        details: { nodeId: params.nodeId, framework, code, screenshotDataUrl, screenshotSize, assets },
      };
    },
  });

  const bakeLayout = defineTool({
    name: 'pen_bake_layout',
    label: 'Bake Measured Layout',
    description: 'Write browser-measured node sizes back into the model as fixed sizes (spec §3.8). ' +
      'Reads the measured-bounds runtime cache the DOM renderer pushes (native layout mode) and emits ONE ' +
      'update_many patch with real width/height. Nodes whose .pen sizing is dynamic (fit_content / ' +
      'fill_container) are skipped — baking would fight the layout engine. ' +
      'Without measured data (SVG renderer, no client) nothing changes.',
    promptSnippet: 'Bake measured bounds into node sizes (requires measured data from a connected client).',
    parameters: Type.Object({
      nodeIds: Type.Optional(Type.Array(Type.String({ description: 'Node ids to bake' }))),
      all: Type.Optional(Type.Boolean({ description: 'Bake every node with measured bounds' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const doc = ctx.getDocument?.();
      const documentId = doc?.id ?? '';
      const bounds = documentId ? getMeasuredBounds(documentId) : {};
      const measuredIds = Object.keys(bounds).filter((id) => {
        const b = bounds[id];
        return b && Number.isFinite(b.width) && Number.isFinite(b.height) && (b.width > 0 || b.height > 0);
      });

      if (measuredIds.length === 0) {
        const requested = params.all ? 'all nodes' : (params.nodeIds ?? []).join(', ') || '(none specified)';
        const text = `no measured bounds available (SVG renderer, parity mode, or no client push yet); no changes made\n` +
          `Requested: ${requested}\n` +
          `Tip: measured bounds flow when the DOM renderer runs in native layout mode (settings → renderer 'dom').`;
        return { content: [{ type: 'text', text }], details: { measured: false, requested: { nodeIds: params.nodeIds ?? null, all: params.all ?? false }, patch: null } };
      }

      // Candidate ids: explicit list intersected with the measured map, or
      // every measured id when `all`.
      const requestedIds = params.all ? measuredIds : (params.nodeIds ?? []).filter((id) => measuredIds.includes(id));
      if (requestedIds.length === 0) {
        const text = `none of the requested node ids have measured bounds (${measuredIds.length} measured id(s) available); no changes made`;
        return { content: [{ type: 'text', text }], details: { measured: false, requested: { nodeIds: params.nodeIds ?? null, all: params.all ?? false }, patch: null, measuredIds } };
      }

      // Dynamic-sizing guard (spec: never bake fit_content / fill_container).
      const { tree } = doc ? resolvePenTreeDetailed(doc) : { tree: [] as ResolvedTreeNode[] };
      const skipped: Array<{ id: string; reason: string }> = [];
      const updates: Array<{ id: string; changes: Record<string, number> }> = [];
      for (const id of requestedIds) {
        const tn = findTreeNode(tree, id);
        const pen = tn?.pen as Partial<PenChild> | undefined;
        const wDyn = pen && typeof (pen as { width?: unknown }).width === 'string';
        const hDyn = pen && typeof (pen as { height?: unknown }).height === 'string';
        if (wDyn || hDyn) {
          skipped.push({
            id,
            reason: `dynamic sizing (width=${wDyn ? String((pen as { width?: unknown }).width) : 'fixed'}, height=${hDyn ? String((pen as { height?: unknown }).height) : 'fixed'}) — skipped, the layout engine owns this size`,
          });
          continue;
        }
        const b = bounds[id];
        updates.push({ id, changes: { width: Math.round(b.width), height: Math.round(b.height) } });
      }

      if (updates.length === 0) {
        const text = `all requested nodes use dynamic sizing (fit_content / fill_container) — nothing baked\n` +
          skipped.map((s) => `  ${s.id}: ${s.reason}`).join('\n');
        return { content: [{ type: 'text', text }], details: { measured: true, baked: 0, skipped, patch: null } };
      }

      const patch: CanvasPatch = {
        op: 'update_many',
        updates,
        summary: `Baked measured layout into ${updates.length} node(s)`,
      };
      ctx.applyPatch(patch);
      const lines = [
        `Baked measured sizes into ${updates.length} node(s):`,
        ...updates.map((u) => `  ${u.id}: ${u.changes.width}×${u.changes.height}`),
      ];
      if (skipped.length > 0) {
        lines.push(`Skipped ${skipped.length} dynamic-sizing node(s):`);
        lines.push(...skipped.map((s) => `  ${s.id}: ${s.reason}`));
      }
      return { content: [{ type: 'text', text: lines.join('\n') }], details: { measured: true, baked: updates.length, skipped, patch } };
    },
  });

  const getComputed = defineTool({
    name: 'pen_get_computed',
    label: 'Get Computed Styles (live DOM readback)',
    description: 'Read REAL browser-computed styles + measured rects for specific nodes (getComputedStyle + ' +
      'getBoundingClientRect on the live DOM renderer). No Figma analog — the DOM-renderer dividend. ' +
      'Use it to verify your own work after patches: actual widths, contrast, computed colors post-variable-resolution, ' +
      'flex gap/padding reality. Falls back to resolver-predicted data (measured:false) when no client ' +
      'is connected — never hangs.',
    promptSnippet: 'Read real computed styles + measured rects for nodes (live DOM readback).',
    parameters: Type.Object({
      nodeIds: Type.Array(Type.String({ description: 'Node ids to read (use pen_get_metadata to find ids)' }), { minItems: 1, maxItems: 20 }),
      properties: Type.Optional(Type.Array(Type.String({
        description: 'Optional computed-style property filter (camelCase: backgroundColor, fontSize, gap, …). Default: curated ~33-prop subset',
      }))),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!params.nodeIds || params.nodeIds.length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: nodeIds must be a non-empty array. Call pen_get_metadata (no nodeId) for the page list, then pass nodeIds for the sparse tree.' }],
          details: { error: 'no_node_ids' },
          isError: true as any,
        };
      }
      const shapes = ctx.getShapes();
      const byId = new Map(shapes.map((s) => [s.id, s] as const));

      // Round-trip first (≤2s). No sink (outside a turn) → straight fallback.
      let clientResults: ComputedResult[] | null = null;
      if (hasSink()) {
        clientResults = await awaitClientResponse<ComputedResult[]>(
          toolCallId,
          () => emitEvent({ type: 'agent:computed_request', toolCallId, nodeIds: params.nodeIds, properties: params.properties }),
          ROUNDTRIP_DEFAULTS.computedTimeoutMs,
        );
      }
      const byClient = new Map((clientResults ?? []).map((r) => [r.id, r] as const));

      const results: ComputedResult[] = params.nodeIds.map((id) => {
        const live = byClient.get(id);
        if (live) return { ...live, measured: true };
        const s = byId.get(id);
        if (s) return resolverComputedFallback(s, params.properties);
        return {
          id,
          rect: { x: 0, y: 0, width: 0, height: 0 },
          computed: {},
          measured: false,
        };
      });

      const liveCount = results.filter((r) => r.measured).length;
      const summaryLine = liveCount === params.nodeIds.length
        ? `All ${results.length} node(s) read from the LIVE DOM (measured: true).`
        : liveCount > 0
          ? `${liveCount}/${results.length} node(s) read from the live DOM; the rest fell back to resolver data (measured: false).`
          : `client offline — resolver fallback (measured: false for all ${results.length} node(s))`;

      const blocks = results.map((r) => {
        const rect = r.canvasRect ?? r.rect;
        const propLines = Object.entries(r.computed).map(([k, v]) => `    ${k}: ${v}`);
        return [
          `node ${r.id}${byId.get(r.id) ? ` (${byId.get(r.id)!.type} "${byId.get(r.id)!.name}")` : ' (unknown id)'} — measured: ${r.measured === true}`,
          `    rect (canvas space): x=${rect.x} y=${rect.y} w=${rect.width} h=${rect.height}`,
          ...(propLines.length > 0 ? propLines : ['    (no computed properties available)']),
        ].join('\n');
      });

      const unknown = results.filter((r) => !byId.get(r.id) && !byClient.get(r.id));
      const text = [summaryLine, ...blocks].join('\n\n') +
        (unknown.length > 0 ? `\n\nUnknown node id(s) (not in canvas or DOM): ${unknown.map((u) => u.id).join(', ')}` : '');
      return { content: [{ type: 'text', text }], details: { measured: liveCount > 0, liveCount, results } };
    },
  });

  const getScreenshot = defineTool({
    name: 'pen_get_screenshot',
    label: 'Get Screenshot (real canvas)',
    description: 'Capture a PNG screenshot of the REAL rendered canvas — the DOM renderer captured via ' +
      'html-to-image at the requested scale (default 2). Figma MCP analog: get_screenshot. Use for ' +
      'self-verification after building UI. Falls back to the server-side resvg render (measured:false, ' +
      'images dropped) when no client responds within 2s — never hangs. The data URL lands in ' +
      'details.screenshotDataUrl; the text carries dimensions + KB only (tool-result size caps).',
    promptSnippet: 'Screenshot the real rendered canvas (client capture, server fallback).',
    parameters: Type.Object({
      nodeId: Type.Optional(Type.String({ description: 'Optional node id — informational scope hint; the capture covers the visible canvas' })),
      scale: Type.Optional(Type.Number({ description: 'Pixel ratio for the capture (default 2)' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const shot = await requestClientScreenshot(toolCallId, params.nodeId, params.scale, ROUNDTRIP_DEFAULTS.screenshotTimeoutMs);
      if (shot?.dataUrl) {
        const kb = Math.round(shot.dataUrl.length / 1024);
        const text = `Real client screenshot captured${params.nodeId ? ` (scope hint: node ${params.nodeId}; capture covers the visible canvas)` : ''} — ` +
          `PNG data URL in details.screenshotDataUrl (${kb} KB), measured: true.`;
        return { content: [{ type: 'text', text }], details: { screenshotDataUrl: shot.dataUrl, measured: true, scale: params.scale ?? 2 } };
      }

      // Fallback — server-side resvg render of the full document bbox.
      const shapes = ctx.getShapes();
      if (shapes.length === 0) {
        return { content: [{ type: 'text', text: 'Canvas is empty — nothing to screenshot.' }], details: { measured: false } };
      }
      try {
        const minX = Math.min(...shapes.map((s) => s.x));
        const minY = Math.min(...shapes.map((s) => s.y));
        const maxX = Math.max(...shapes.map((s) => s.x + s.width));
        const maxY = Math.max(...shapes.map((s) => s.y + s.height));
        const w = Math.max(1, Math.round(maxX - minX));
        const h = Math.max(1, Math.round(maxY - minY));
        const shifted = shapes.map((s) => ({ ...s, x: s.x - minX, y: s.y - minY }));
        const { renderCanvasToPng } = await import('../canvas/render-to-png');
        const png = await renderCanvasToPng(shifted, w, h);
        const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
        const kb = Math.round(dataUrl.length / 1024);
        const reason = shot?.error ? `client reported: ${shot.error}` : 'no client responded within the timeout';
        const text = `client offline — resolver fallback (${reason}); server-side PNG render ${w}×${h} @2x, ` +
          `data URL in details.screenshotDataUrl (${kb} KB), measured: false (server approximation — images may be dropped).`;
        return { content: [{ type: 'text', text }], details: { screenshotDataUrl: dataUrl, measured: false, width: w, height: h, scale: 2 } };
      } catch (err) {
        const reason = shot?.error ? `client: ${shot.error}` : 'no client + server render failed';
        return {
          content: [{ type: 'text', text: `screenshot unavailable (${reason}): ${err instanceof Error ? err.message : String(err)}` }],
          details: { measured: false, error: err instanceof Error ? err.message : String(err), clientError: shot?.error },
          isError: true as any,
        };
      }
    },
  });

  // =====================================================================
  // PHASE 2c: FIND & FILTER (3 tools)
  // Lets the agent query and bulk-transform nodes without first calling
  // pen_get_metadata and filtering client-side.
  // =====================================================================

  const findShapes = defineTool({
    name: 'pen_find_nodes',
    label: 'Find Nodes',
    description: 'Find nodes matching a filter. Returns node IDs and a summary. Read-only. ' +
      'Use this to bulk-select nodes by type, color, name, or parent. ' +
      'Example: find all ellipses, find all nodes with fill #ff0000, find all children of a frame.',
    promptSnippet: 'Find nodes by type/color/name/parent.',
    parameters: Type.Object({
      type: Type.Optional(ShapeTypeSchema),
      fill: Type.Optional(Type.String({ description: 'Filter by exact fill color' })),
      nameContains: Type.Optional(Type.String({ description: 'Filter by name (substring match)' })),
      parentId: Type.Optional(Type.String({ description: 'Filter by parent shape ID' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      let results = ctx.getShapes();
      if (params.type) results = results.filter((s) => s.type === params.type);
      if (params.fill) results = results.filter((s) => s.fill === params.fill);
      if (params.nameContains) results = results.filter((s) => s.name.toLowerCase().includes(params.nameContains!.toLowerCase()));
      if (params.parentId) results = results.filter((s) => s.parentId === params.parentId);
      const lines = results.map((s) => `  ${s.id}  ${s.type.padEnd(10)} "${s.name}"  (${Math.round(s.x)},${Math.round(s.y)}) ${Math.round(s.width)}×${Math.round(s.height)} fill=${s.fill}`);
      const report = `Found ${results.length} shape(s):\n${lines.join('\n') || '  (none)'}`;
      return { content: [{ type: 'text', text: report }], details: { count: results.length, shapeIds: results.map((s) => s.id) } };
    },
  });

  const bulkUpdateByFilter = defineTool({
    name: 'pen_bulk_update_by_filter',
    label: 'Bulk Update by Filter',
    description: 'Update all nodes matching a filter. Combines pen_find_nodes + pen_update_node into one call. ' +
      'Example: "make all ellipses red" → filter type=ellipse, changes fill=#ff0000.',
    promptSnippet: 'Update all shapes matching a filter in one call.',
    parameters: Type.Object({
      type: Type.Optional(ShapeTypeSchema),
      fill: Type.Optional(Type.String({ description: 'Filter by current fill color' })),
      nameContains: Type.Optional(Type.String({ description: 'Filter by name (substring)' })),
      parentId: Type.Optional(Type.String({ description: 'Filter by parent ID' })),
      changes: ShapeInputSchema,
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      let matches = ctx.getShapes();
      if (params.type) matches = matches.filter((s) => s.type === params.type);
      if (params.fill) matches = matches.filter((s) => s.fill === params.fill);
      if (params.nameContains) matches = matches.filter((s) => s.name.toLowerCase().includes(params.nameContains!.toLowerCase()));
      if (params.parentId) matches = matches.filter((s) => s.parentId === params.parentId);
      if (matches.length === 0) {
        return { content: [{ type: 'text', text: 'No shapes matched the filter.' }], details: { error: 'no_matches', count: 0 }, isError: true as any };
      }
      const coerced = coerceShapeInput(params.changes);
      const updates = matches.map((s) => ({ id: s.id, changes: coerced }));
      const patch: CanvasPatch = { op: 'update_many', updates, summary: `Bulk-updated ${matches.length} shape(s): ${Object.keys(coerced).join(', ')}` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Updated ${matches.length} shape(s) with ${Object.keys(coerced).join(', ')}.` }], details: { count: matches.length, patch } };
    },
  });

  const findReplaceText = defineTool({
    name: 'pen_find_replace_text',
    label: 'Find & Replace Text',
    description: 'Find and replace text across all text shapes on the canvas. Supports plain string matching. ' +
      'Example: find "Lorem" replace "Welcome" — updates every text shape containing "Lorem".',
    promptSnippet: 'Find and replace text in all text shapes.',
    parameters: Type.Object({
      find: Type.String({ description: 'Text to find (exact substring match)' }),
      replace: Type.String({ description: 'Replacement text' }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const textShapes = ctx.getShapes().filter((s) => s.type === 'text' && s.text && s.text.includes(params.find));
      if (textShapes.length === 0) {
        return { content: [{ type: 'text', text: `No text shapes containing "${params.find}" found.` }], details: { count: 0 } };
      }
      const updates = textShapes.map((s) => ({ id: s.id, changes: { text: s.text!.replace(new RegExp(escapeRegex(params.find), 'g'), params.replace) } as Partial<Shape> }));
      const patch: CanvasPatch = { op: 'update_many', updates, summary: `Replaced "${params.find}" → "${params.replace}" in ${updates.length} text shape(s)` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Replaced "${params.find}" with "${params.replace}" in ${updates.length} text shape(s).` }], details: { count: updates.length, patch } };
    },
  });

  // =====================================================================
  // PHASE 5a: VECTOR EDITING (3 tools)
  // create_path: arbitrary polygon / polyline
  // boolean_op: simplified — creates a group + sets maskId
  // mask_with: sets maskId on a shape
  // =====================================================================

  const createPath = defineTool({
    name: 'pen_create_path',
    label: 'Create Path / Polygon',
    description: 'Create a freeform path shape from a list of points. ' +
      'If closed=true, the path is filled (polygon); if closed=false, it\'s a stroked polyline. ' +
      'Points are canvas-space {x, y} coordinates. Minimum 2 points.',
    promptSnippet: 'Create a path/polyline from points.',
    parameters: Type.Object({
      points: Type.Array(Type.Object({ x: Type.Number(), y: Type.Number() }), { description: 'List of {x, y} points (min 2)' }),
      closed: Type.Optional(Type.Boolean({ description: 'Close the path and fill it (polygon). Default false.' })),
      name: Type.Optional(Type.String({ description: 'Layer name' })),
      fill: Type.Optional(Type.String({ description: 'Fill color (closed paths only)' })),
      stroke: Type.Optional(Type.String({ description: 'Stroke color' })),
      strokeWidth: Type.Optional(Type.Number({ description: 'Stroke width in px' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!Array.isArray(params.points) || params.points.length < 2) {
        return { content: [{ type: 'text', text: 'Error: need at least 2 points' }], details: { error: 'invalid_points' }, isError: true as any };
      }
      const id = crypto.randomUUID();
      const pts = params.points.map((p) => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }));
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const maxX = Math.max(...xs);
      const maxY = Math.max(...ys);
      const shape: Partial<Shape> = {
        id,
        type: 'path',
        name: params.name ?? 'Path',
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
        fill: params.fill ?? '#e2e8f0',
        stroke: params.stroke ?? '#0f172a',
        strokeWidth: params.strokeWidth ?? (params.closed ? 0 : 2),
        radius: 0,
        fontSize: 16,
        textColor: '#0f172a',
        points: pts,
        closed: params.closed ?? false,
        zIndex: ctx.getShapes().length,
      };
      const patch: CanvasPatch = { op: 'add', shapeId: id, shape, summary: `Created ${params.closed ? 'polygon' : 'polyline'} with ${pts.length} points` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Created path with id ${id}, ${pts.length} points. Bounding box: (${Math.round(minX)},${Math.round(minY)}) ${Math.round(maxX - minX)}×${Math.round(maxY - minY)}.` }], details: { shapeId: id, pointCount: pts.length, patch } };
    },
  });

  const booleanOp = defineTool({
    name: 'pen_boolean_op',
    label: 'Boolean Operation',
    description: 'Combine two shapes using a boolean operation. ' +
      'NOTE: this is a simplified implementation — true vector boolean math requires a polygon-clipping library. ' +
      'union: groups both shapes under a single group with unified fill. ' +
      'subtract: sets the second shape as a mask (clips the first). ' +
      'intersect: same as subtract (mask intersection). ' +
      'exclude: hides the second shape (visual approximation).',
    promptSnippet: 'Boolean-combine two shapes (union/subtract/intersect/exclude).',
    parameters: Type.Object({
      shapeId: Type.String({ description: 'Primary shape' }),
      otherShapeId: Type.String({ description: 'Second shape' }),
      operation: Type.Union(
        [Type.Literal('union'), Type.Literal('subtract'), Type.Literal('intersect'), Type.Literal('exclude')],
        { description: 'Boolean operation' },
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const shape = ctx.getShapes().find((s) => s.id === params.shapeId);
      const other = ctx.getShapes().find((s) => s.id === params.otherShapeId);
      if (!shape || !other) {
        return { content: [{ type: 'text', text: `Error: one or both shapes not found` }], details: { error: 'not_found' }, isError: true as any };
      }
      if (params.operation === 'union') {
        // Group both shapes and unify their fill.
        const patch: CanvasPatch = { op: 'group', shapeIds: [params.shapeId, params.otherShapeId], groupId: crypto.randomUUID(), summary: `Union: grouped ${shape.name} + ${other.name}` };
        ctx.applyPatch(patch);
        return { content: [{ type: 'text', text: `Union: grouped "${shape.name}" and "${other.name}" into a single group.` }], details: { operation: 'union', patch } };
      }
      if (params.operation === 'subtract' || params.operation === 'intersect') {
        // Set maskId on the first shape to the second shape's id.
        const patch: CanvasPatch = { op: 'update', shapeId: params.shapeId, shape: { maskId: params.otherShapeId }, summary: `${params.operation}: masked ${shape.name} with ${other.name}` };
        ctx.applyPatch(patch);
        return { content: [{ type: 'text', text: `${params.operation}: set "${other.name}" as a mask on "${shape.name}".` }], details: { operation: params.operation, patch } };
      }
      // exclude — hide the second shape (approximation).
      const patch: CanvasPatch = { op: 'update', shapeId: params.otherShapeId, shape: { visible: false }, summary: `Exclude: hid ${other.name}` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Exclude: hid "${other.name}" (approximation).` }], details: { operation: 'exclude', patch } };
    },
  });

  const maskWith = defineTool({
    name: 'pen_mask_with',
    label: 'Mask with Shape',
    description: 'Clip a shape using another shape as a mask. The mask shape\'s geometry defines the visible region of the target. ' +
      'To remove a mask, call this with maskId=null (or use pen_update_node to clear maskId).',
    promptSnippet: 'Mask one shape with another.',
    parameters: Type.Object({
      shapeId: Type.String({ description: 'Shape to be masked (clipped)' }),
      maskShapeId: Type.Optional(Type.String({ description: 'Shape to use as mask. Omit or set to null to remove the mask.' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const shape = ctx.getShapes().find((s) => s.id === params.shapeId);
      if (!shape) {
        return { content: [{ type: 'text', text: `Error: no shape with id ${params.shapeId}` }], details: { error: 'not_found' }, isError: true as any };
      }
      const maskId = params.maskShapeId ?? null;
      if (maskId) {
        const mask = ctx.getShapes().find((s) => s.id === maskId);
        if (!mask) {
          return { content: [{ type: 'text', text: `Error: no mask shape with id ${maskId}` }], details: { error: 'mask_not_found' }, isError: true as any };
        }
      }
      const patch: CanvasPatch = { op: 'update', shapeId: params.shapeId, shape: { maskId }, summary: maskId ? `Masked ${shape.name}` : `Removed mask from ${shape.name}` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: maskId ? `Masked "${shape.name}" with shape ${maskId}.` : `Removed mask from "${shape.name}".` }], details: { shapeId: params.shapeId, maskId, patch } };
    },
  });

  // =====================================================================
  // PHASE 5b: EFFECTS & STYLING (4 tools)
  // gradient fill, drop shadow, blur, per-corner radii
  // =====================================================================

  const setGradientFill = defineTool({
    name: 'pen_set_gradient_fill',
    label: 'Set Gradient Fill',
    description: 'Set a linear or radial gradient fill on a shape. Overrides the solid `fill` color. ' +
      'Provide 2+ stops (offset 0..1, color hex). For linear, specify angle 0..360 (0=→, 90=↓, 180=←, 270=↑).',
    promptSnippet: 'Apply a gradient fill to a shape.',
    parameters: Type.Object({
      shapeId: Type.String({ description: 'Shape ID' }),
      type: Type.Union([Type.Literal('linear'), Type.Literal('radial')], { description: 'Gradient type' }),
      angle: Type.Optional(Type.Number({ description: 'Angle in degrees (linear only). Default 90.' })),
      stops: Type.Array(Type.Object({
        offset: Type.Number({ description: '0..1' }),
        color: Type.String({ description: 'Hex color' }),
      }), { description: 'Color stops (min 2)' }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const shape = ctx.getShapes().find((s) => s.id === params.shapeId);
      if (!shape) {
        return { content: [{ type: 'text', text: `Error: no shape with id ${params.shapeId}` }], details: { error: 'not_found' }, isError: true as any };
      }
      if (!Array.isArray(params.stops) || params.stops.length < 2) {
        return { content: [{ type: 'text', text: 'Error: need at least 2 gradient stops' }], details: { error: 'invalid_stops' }, isError: true as any };
      }
      const gradient = {
        type: params.type === 'radial' ? 'radial' as const : 'linear' as const,
        angle: params.angle ?? 90,
        stops: params.stops.map((s) => ({ offset: Number(s.offset) || 0, color: String(s.color) })),
      };
      const patch: CanvasPatch = { op: 'update', shapeId: params.shapeId, shape: { gradient, fill: gradient.stops[0].color }, summary: `Set ${gradient.type} gradient on ${shape.name}` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Set ${gradient.type} gradient (${gradient.stops.length} stops) on "${shape.name}".` }], details: { shapeId: params.shapeId, gradient, patch } };
    },
  });

  const setShadow = defineTool({
    name: 'pen_set_shadow',
    label: 'Set Drop Shadow',
    description: 'Apply a drop shadow to a shape. Set blur=0 and color=transparent to remove. ' +
      'The shadow is rendered via an SVG filter on the client.',
    promptSnippet: 'Apply a drop shadow to a shape.',
    parameters: Type.Object({
      shapeId: Type.String({ description: 'Shape ID' }),
      x: Type.Number({ description: 'X offset in px' }),
      y: Type.Number({ description: 'Y offset in px' }),
      blur: Type.Number({ description: 'Blur radius in px' }),
      color: Type.String({ description: 'Shadow color (hex, e.g. #00000033 for semi-transparent black)' }),
      spread: Type.Optional(Type.Number({ description: 'Spread in px (default 0)' })),
      inset: Type.Optional(Type.Boolean({ description: 'Inset shadow (default false)' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const shape = ctx.getShapes().find((s) => s.id === params.shapeId);
      if (!shape) {
        return { content: [{ type: 'text', text: `Error: no shape with id ${params.shapeId}` }], details: { error: 'not_found' }, isError: true as any };
      }
      const shadow = {
        x: Number(params.x) || 0,
        y: Number(params.y) || 0,
        blur: Number(params.blur) || 0,
        color: String(params.color),
        spread: params.spread !== undefined ? Number(params.spread) : 0,
        inset: !!params.inset,
      };
      const patch: CanvasPatch = { op: 'update', shapeId: params.shapeId, shape: { shadow }, summary: `Set shadow on ${shape.name}` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Set shadow (${shadow.x},${shadow.y}, blur ${shadow.blur}px) on "${shape.name}".` }], details: { shapeId: params.shapeId, shadow, patch } };
    },
  });

  const setBlur = defineTool({
    name: 'pen_set_blur',
    label: 'Set Blur',
    description: 'Apply a Gaussian blur to a shape. Set radius to 0 to remove. Rendered via an SVG filter.',
    promptSnippet: 'Apply a Gaussian blur to a shape.',
    parameters: Type.Object({
      shapeId: Type.String({ description: 'Shape ID' }),
      radius: Type.Number({ description: 'Blur radius in px (0 to remove)' }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const shape = ctx.getShapes().find((s) => s.id === params.shapeId);
      if (!shape) {
        return { content: [{ type: 'text', text: `Error: no shape with id ${params.shapeId}` }], details: { error: 'not_found' }, isError: true as any };
      }
      const blur = Math.max(0, Number(params.radius) || 0);
      const patch: CanvasPatch = { op: 'update', shapeId: params.shapeId, shape: { blur }, summary: `Set blur ${blur}px on ${shape.name}` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Set blur ${blur}px on "${shape.name}".` }], details: { shapeId: params.shapeId, blur, patch } };
    },
  });

  const setCornerRadiusPerCorner = defineTool({
    name: 'pen_set_corner_radius_per_corner',
    label: 'Set Per-Corner Radii',
    description: 'Set independent border radii for each corner of a rectangle or frame. ' +
      'Overrides the uniform `radius` property.',
    promptSnippet: 'Set per-corner border radii on a shape.',
    parameters: Type.Object({
      shapeId: Type.String({ description: 'Shape ID (rectangle or frame)' }),
      topLeft: Type.Number({ description: 'Top-left radius in px' }),
      topRight: Type.Number({ description: 'Top-right radius in px' }),
      bottomRight: Type.Number({ description: 'Bottom-right radius in px' }),
      bottomLeft: Type.Number({ description: 'Bottom-left radius in px' }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const shape = ctx.getShapes().find((s) => s.id === params.shapeId);
      if (!shape) {
        return { content: [{ type: 'text', text: `Error: no shape with id ${params.shapeId}` }], details: { error: 'not_found' }, isError: true as any };
      }
      if (shape.type !== 'rectangle' && shape.type !== 'frame') {
        return { content: [{ type: 'text', text: `Error: per-corner radii only apply to rectangle/frame shapes (got ${shape.type})` }], details: { error: 'wrong_type', shapeType: shape.type }, isError: true as any };
      }
      const radii = {
        topLeft: Math.max(0, Number(params.topLeft) || 0),
        topRight: Math.max(0, Number(params.topRight) || 0),
        bottomRight: Math.max(0, Number(params.bottomRight) || 0),
        bottomLeft: Math.max(0, Number(params.bottomLeft) || 0),
      };
      const patch: CanvasPatch = { op: 'update', shapeId: params.shapeId, shape: { radii }, summary: `Set per-corner radii on ${shape.name}` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Set per-corner radii (${radii.topLeft}/${radii.topRight}/${radii.bottomRight}/${radii.bottomLeft}) on "${shape.name}".` }], details: { shapeId: params.shapeId, radii, patch } };
    },
  });

  // =====================================================================
  // PHASE 5c: IMAGE SUPPORT (3 tools)
  // upload_image, search_icons (Lucide path data), generate_image (placeholder)
  // =====================================================================

  const uploadImage = defineTool({
    name: 'pen_upload_image',
    label: 'Place Image',
    description: 'Place an image on the canvas from a data URL or remote URL. ' +
      'Use this for logos, photos, or any raster image. The image is rendered via an SVG <image> element. ' +
      'Data URLs (base64) are preferred for persistence; remote URLs may break if the host goes down.',
    promptSnippet: 'Place an image on the canvas.',
    parameters: Type.Object({
      src: Type.String({ description: 'Image source — data URL (data:image/...) or remote URL (https://...)' }),
      x: Type.Number({ description: 'Canvas-space X' }),
      y: Type.Number({ description: 'Canvas-space Y' }),
      width: Type.Optional(Type.Number({ description: 'Display width in px (default: natural width, max 400)' })),
      height: Type.Optional(Type.Number({ description: 'Display height in px (default: natural height, max 400)' })),
      name: Type.Optional(Type.String({ description: 'Layer name' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const id = crypto.randomUUID();
      const w = Number(params.width) || 200;
      const h = Number(params.height) || 200;
      const shape: Partial<Shape> = {
        id,
        type: 'image',
        name: params.name ?? 'Image',
        x: Number(params.x) || 0,
        y: Number(params.y) || 0,
        width: w,
        height: h,
        fill: 'transparent',
        stroke: '#94a3b8',
        strokeWidth: 0,
        radius: 0,
        fontSize: 16,
        textColor: '#0f172a',
        src: String(params.src),
        zIndex: ctx.getShapes().length,
      };
      const patch: CanvasPatch = { op: 'add', shapeId: id, shape, summary: `Placed image "${params.name ?? 'Image'}" at (${params.x}, ${params.y})` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Placed image with id ${id} at (${params.x}, ${params.y}), size ${w}×${h}.` }], details: { shapeId: id, patch } };
    },
  });

  const searchIcons = defineTool({
    name: 'pen_search_icons',
    label: 'Place Icon',
    description: 'Place a Lucide icon on the canvas as a path shape. ' +
      'Renders the icon as a stroked polyline path. ' +
      'Available icons: check, x, plus, minus, arrow-right, arrow-left, arrow-up, arrow-down, ' +
      'chevron-down, chevron-up, chevron-left, chevron-right, search, settings, user, heart, ' +
      'star, bell, mail, phone, calendar, clock, home, menu, share, download, upload, ' +
      'edit, trash, copy, lock, unlock, eye, eye-off.',
    promptSnippet: 'Place a Lucide icon on the canvas.',
    parameters: Type.Object({
      icon: Type.String({ description: 'Icon name (see description for list)' }),
      x: Type.Number({ description: 'Canvas-space X' }),
      y: Type.Number({ description: 'Canvas-space Y' }),
      size: Type.Optional(Type.Number({ description: 'Icon size in px (default 24)' })),
      stroke: Type.Optional(Type.String({ description: 'Stroke color (default #0f172a)' })),
      strokeWidth: Type.Optional(Type.Number({ description: 'Stroke width (default 2)' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const iconData = LUCIDE_ICONS[params.icon.toLowerCase()];
      if (!iconData) {
        const available = Object.keys(LUCIDE_ICONS).join(', ');
        return { content: [{ type: 'text', text: `Icon "${params.icon}" not found. Available: ${available}` }], details: { error: 'icon_not_found', requested: params.icon, available: Object.keys(LUCIDE_ICONS) }, isError: true as any };
      }
      const id = crypto.randomUUID();
      const sz = Number(params.size) || 24;
      const sw = params.strokeWidth ?? 2;
      const sc = params.stroke ?? '#0f172a';
      // Lucide icons are 24×24 viewBox. Scale to requested size.
      const scale = sz / 24;
      const points = iconData.map((p: { x: number; y: number }) => ({ x: (params.x || 0) + p.x * scale, y: (params.y || 0) + p.y * scale }));
      const shape: Partial<Shape> = {
        id,
        type: 'path',
        name: `Icon: ${params.icon}`,
        x: params.x || 0,
        y: params.y || 0,
        width: sz,
        height: sz,
        fill: 'transparent',
        stroke: sc,
        strokeWidth: sw,
        radius: 0,
        fontSize: 16,
        textColor: '#0f172a',
        points,
        closed: false,
        zIndex: ctx.getShapes().length,
      };
      const patch: CanvasPatch = { op: 'add', shapeId: id, shape, summary: `Placed icon "${params.icon}" at (${params.x}, ${params.y})` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Placed icon "${params.icon}" with id ${id} at (${params.x}, ${params.y}), size ${sz}px.` }], details: { shapeId: id, icon: params.icon, patch } };
    },
  });

  const generateImage = defineTool({
    name: 'pen_generate_image',
    label: 'Generate Image (placeholder)',
    description: 'Generate an image from a text prompt and place it on the canvas. ' +
      'NOTE: in this sandbox, this tool places a placeholder rectangle with the prompt text — ' +
      'actual AI image generation requires the image-generation API. ' +
      'The placeholder uses a dashed border so the user knows to replace it.',
    promptSnippet: 'Generate an image from a prompt and place it.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Image generation prompt' }),
      x: Type.Number({ description: 'Canvas-space X' }),
      y: Type.Number({ description: 'Canvas-space Y' }),
      width: Type.Optional(Type.Number({ description: 'Width in px (default 320)' }),
      ),
      height: Type.Optional(Type.Number({ description: 'Height in px (default 200)' }),
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const id = crypto.randomUUID();
      const w = Number(params.width) || 320;
      const h = Number(params.height) || 200;
      // Create a placeholder rectangle with a label.
      const shape: Partial<Shape> = {
        id,
        type: 'rectangle',
        name: `Generated: ${params.prompt.slice(0, 30)}`,
        x: Number(params.x) || 0,
        y: Number(params.y) || 0,
        width: w,
        height: h,
        fill: '#f1f5f9',
        stroke: '#94a3b8',
        strokeWidth: 2,
        radius: 8,
        fontSize: 13,
        textColor: '#64748b',
        zIndex: ctx.getShapes().length,
      };
      const patch: CanvasPatch = { op: 'add', shapeId: id, shape, summary: `Placed image placeholder for "${params.prompt.slice(0, 40)}"` };
      ctx.applyPatch(patch);
      // Also add a text label.
      const textId = crypto.randomUUID();
      const textShape: Partial<Shape> = {
        id: textId,
        type: 'text',
        name: 'Image prompt label',
        x: (params.x || 0) + 12,
        y: (params.y || 0) + h / 2,
        width: w - 24,
        height: 32,
        fill: 'transparent',
        stroke: 'transparent',
        strokeWidth: 0,
        radius: 0,
        fontSize: 13,
        textColor: '#64748b',
        text: `AI image: ${params.prompt.slice(0, 50)}`,
        zIndex: (shape.zIndex ?? 0) + 1,
      };
      const textPatch: CanvasPatch = { op: 'add', shapeId: textId, shape: textShape, summary: 'Image prompt label' };
      ctx.applyPatch(textPatch);
      return { content: [{ type: 'text', text: `Placed an image placeholder at (${params.x}, ${params.y}), size ${w}×${h}. Prompt: "${params.prompt}". Replace it with pen_upload_image once you have the generated image.` }], details: { shapeId: id, prompt: params.prompt, patch } };
    },
  });

  // =====================================================================
  // WEB RESEARCH TOOLS (web_search + web_fetch)
  //
  // Zero-config, no-API-key web access. Tries four providers in sequence:
  //   1. z.ai web_search / page_reader (sandbox-native, auto-credentials)
  //   2. DuckDuckGo HTML (no key)
  //   3. Startpage (no key, Google-index)
  //   4. Jina AI (s.jina.ai / r.jina.ai, no auth)
  //
  // See `src/lib/web/search.ts` and `src/lib/web/fetch.ts` for details.
  // These tools are read-only — they return text content for the LLM and
  // never mutate the canvas.
  // =====================================================================

  const webSearchTool = defineTool({
    name: 'web_search',
    label: 'Web Search',
    description:
      'Search the web for up-to-date information. Returns a numbered list of results with title, URL, snippet, and publish date. ' +
      'Use this when the user asks about current events, recent releases, real-world products, or anything not in your training data. ' +
      'Works with zero configuration — no API key needed. Tries multiple search engines (z.ai, DuckDuckGo, Startpage, Jina) in fallback order.',
    promptSnippet: 'Search the web for current information (no API key needed).',
    promptGuidelines: [
      'Call web_search when you need real-world, current, or factual information you don\'t already know.',
      'Pass a concise natural-language query — the same as you would type into Google.',
      'After searching, use web_fetch on a specific result URL to read the full page if you need more detail than the snippet.',
      'You can call web_search multiple times with different queries if needed.',
    ],
    parameters: Type.Object({
      query: Type.String({ description: 'The search query (natural language, like "nextjs 16 features" or "best color palette for fintech apps")' }),
      limit: Type.Optional(Type.Number({ description: 'Max results to return (default 8, max 30)' })),
      recency: Type.Optional(Type.Union(
        [
          Type.Literal('day'),
          Type.Literal('week'),
          Type.Literal('month'),
          Type.Literal('year'),
        ],
        { description: 'Restrict to results from the last day/week/month/year. Omit for no filter.' },
      )),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      // Lazy-load the web module so it never imports on the canvas-only path.
      const { webSearch, formatSearchForLLM } = await import('../web/search');
      try {
        const res = await webSearch({
          query: params.query,
          limit: params.limit,
          recency: params.recency,
        });
        const text = formatSearchForLLM(res);
        return {
          content: [{ type: 'text', text }],
          details: { provider: res.provider, count: res.results.length, error: res.error },
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Web search failed: ${err?.message ?? String(err)}` }],
          details: { error: err?.message },
          isError: true as any,
        };
      }
    },
  });

  const webFetchTool = defineTool({
    name: 'web_fetch',
    label: 'Fetch Web Page',
    description:
      'Fetch a URL and return its content as clean readable markdown / plain text. ' +
      'Handles HTML (with readability extraction), JSON (pretty-printed), RSS/Atom feeds, and plain text. ' +
      'Use this to read a specific web page — e.g. a blog post, documentation page, or API response — in full. ' +
      'Works with zero configuration — no API key needed. Falls back through readability → z.ai page_reader → Jina Reader.',
    promptSnippet: 'Fetch a URL and return readable markdown (no API key needed).',
    promptGuidelines: [
      'Call web_fetch when you have a specific URL and want to read its content.',
      'The URL can be a full https:// URL or a bare domain like "example.com" (https:// is added automatically).',
      'Output is markdown for HTML pages, pretty-printed JSON for API responses, and a top-10 item list for feeds.',
      'Content is capped at 500,000 chars; if truncated, the response notes it.',
      'Set `raw: true` to skip readability extraction and return the cleaned raw HTML.',
    ],
    parameters: Type.Object({
      url: Type.String({ description: 'The URL to fetch (https://example.com/page or bare example.com)' }),
      raw: Type.Optional(Type.Boolean({ description: 'If true, return cleaned raw HTML without readability extraction (default false)' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const { webFetch, formatFetchForLLM } = await import('../web/fetch');
      try {
        const result = await webFetch({ url: params.url, raw: params.raw });
        const text = formatFetchForLLM(result);
        return {
          content: [{ type: 'text', text }],
          details: {
            url: result.finalUrl,
            contentType: result.contentType,
            method: result.method,
            bytes: result.bytes,
            truncated: result.truncated,
            title: result.title,
          },
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Web fetch failed: ${err?.message ?? String(err)}` }],
          details: { url: params.url, error: err?.message },
          isError: true as any,
        };
      }
    },
  });

  // =====================================================================
  // AGENTIC WORKFLOWS (Phase 3 — emerging-pattern agentic capabilities)
  //
  // These tools implement patterns benchmarked against 2025-2026 competitor
  // capabilities (v0's plan/build modes, Galileo AI's iterative refinement,
  // Figma AI's design-direction suggestions, the Reflection pattern, the
  // Memory/RAG pattern).
  //
  //   1. pen_self_critique     — dispatches the design-critic sub-agent
  //                              (reflection pattern: generate → critique → refine)
  //   2. pen_recommend_components — scans canvas for repeated shape patterns
  //                                 and recommends converting them to Components
  //   3. pen_search_design_patterns — RAG retrieval over the design-pattern
  //                                    memory (past successful designs)
  //   4. pen_save_design_pattern  — store the current design as a pattern
  //                                   for future retrieval
  //   5. pen_clear_pattern_memory  — wipe the pattern store
  //   6. pen_pattern_stats         — inspect the pattern store
  // =====================================================================

  const selfCritique = defineTool({
    name: 'pen_self_critique',
    label: 'Self-Critique Design (Reflection)',
    description:
      'Dispatch the design-critic sub-agent to review the current canvas from a senior-designer perspective. ' +
      'Returns a structured critique with severity-tagged findings ([BLOCKER] / [MAJOR] / [MINOR] / [PRAISE]) and a 1-10 score. ' +
      'Implements the Reflection agentic pattern (generate → critique → refine). ' +
      'After receiving the critique, act on each [BLOCKER] and [MAJOR] finding to refine the design.',
    promptSnippet: 'Run a senior-designer critique on the current canvas.',
    promptGuidelines: [
      'Call this AFTER generating a design, not before — it reviews the result, not the prompt.',
      'The critic runs in a separate LLM context (isolated from the generation prompt) to reduce confirmation bias.',
      'Act on every [BLOCKER] finding; address [MAJOR] findings when time/budget allows; [MINOR] findings are optional polish.',
      'Do NOT call this in a tight loop — call once, refine, optionally call again to verify the refinements fixed the issues.',
    ],
    parameters: Type.Object({
      originalPrompt: Type.Optional(Type.String({ description: 'The original user prompt (for context — the critic should NOT let it bias its evaluation, but it helps judge intent satisfaction)' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      // Lazy-import the sub-agent to keep the tools.ts module graph lean.
      const { dispatchDesignCriticSubAgent } = await import('./subagents/design-critic');
      // ctx.getDocument is optional — fall back to a minimal doc if missing.
      const canvas = ctx.getDocument?.() ?? ({
        id: 'critic-no-doc',
        name: 'Untitled',
        children: [],
        shapes: ctx.getShapes(),
        tokens: ctx.getTokens(),
        background: '#ffffff',
        viewport: { zoom: 1, panX: 0, panY: 0 },
        version: '2.17' as const,
      } as unknown as import('../canvas/types').CanvasDocument);
      const result = await dispatchDesignCriticSubAgent({
        task: 'Critique the current canvas design.',
        canvas,
        originalPrompt: params.originalPrompt ?? '(no original prompt provided)',
      });
      return {
        content: [{ type: 'text', text: result.summary }],
        details: {
          subAgent: 'design_critic',
          toolCalls: result.toolCalls,
          success: result.success,
          error: result.error,
        },
      };
    },
  });

  // Task 7-c P1.2 / T1 — pen_generate_design_brief
  //
  // Pre-generation design brief sub-agent. Implements v0's
  // `GenerateDesignInspiration` pattern: BEFORE the main agent starts
  // creating shapes, this tool takes the user prompt and returns a JSON
  // design brief (primary color, accent, neutral ramp, typography,
  // layout grid, information architecture). The agent then uses the brief
  // as the canonical palette/typography reference for ALL subsequent
  // shape creation — closing the "agent improvises colors" failure mode.
  const generateDesignBrief = defineTool({
    name: 'pen_generate_design_brief',
    label: 'Generate Design Brief (Pre-Generation)',
    description:
      'Dispatch the design-brief sub-agent to produce a JSON design brief from the user prompt BEFORE any pen_create_node / pen_generate_wireframe call. ' +
      'Returns: primaryColor, accentColor, neutralPalette, typography (fontFamily, headingScale, bodySize), componentCount, layoutGrid (cols, rows), informationArchitecture (ordered section list). ' +
      'Implements v0\'s GenerateDesignInspiration pattern (think-before-draw). ' +
      'MANDATORY FIRST STEP for any high-fidelity design request — the brief drives all subsequent palette / typography / layout decisions.',
    promptSnippet: 'Produce a JSON design brief from the prompt before drawing anything.',
    promptGuidelines: [
      'Call this FIRST — before pen_create_node / pen_generate_wireframe / pen_apply_palette.',
      'Use the returned primaryColor + accentColor as the $color.primary + $color.accent tokens in pen_set_variable / pen_apply_palette.',
      'Use the neutralPalette (5-7 hex codes) as $color.bg / surface / surface-2 / border / text / text-muted / text-subtle.',
      'Use informationArchitecture as the ordered checklist of components to scaffold (every entry → at least one shape).',
      'Use componentCount as the floor — a design with fewer shapes than this fails the pre-complete validation gate.',
      'Do NOT improvise colors outside the brief — the brief is the source of truth for the whole turn.',
    ],
    parameters: Type.Object({
      prompt: Type.Optional(Type.String({ description: 'The user prompt (defaults to the current task). The sub-agent uses this verbatim to generate the brief.' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { dispatchDesignBriefSubAgent } = await import('./subagents/design-brief');
      const canvas = ctx.getDocument?.() ?? ({
        id: 'brief-no-doc',
        name: 'Untitled',
        children: [],
        shapes: ctx.getShapes(),
        tokens: ctx.getTokens(),
        background: '#ffffff',
        viewport: { zoom: 1, panX: 0, panY: 0 },
        version: '2.17' as const,
      } as unknown as import('../canvas/types').CanvasDocument);
      const result = await dispatchDesignBriefSubAgent({
        task: params.prompt ?? 'Generate a design brief.',
        canvas,
        originalPrompt: params.prompt,
      });
      // Return the JSON brief as the tool-result content. If the brief
      // failed to parse, fall back to the raw summary so the agent can
      // still read what the sub-agent said.
      const briefJson = result.brief ? JSON.stringify(result.brief, null, 2) : result.summary;
      return {
        content: [{ type: 'text', text: briefJson }],
        details: {
          subAgent: 'design_brief',
          toolCalls: result.toolCalls,
          success: result.success,
          error: result.error,
          brief: result.brief,
        },
      };
    },
  });

  // Task 7-c P2.1 / T3 — pen_visual_critique
  //
  // VLM (vision) screenshot critique sub-agent. Mirrors pen_self_critique
  // but feeds the RENDERED canvas (rasterized PNG via renderCanvasToPng)
  // to a vision LLM with the same structured-critique prompt used for the
  // Task 7-a baseline measurement. The VLM catches what the text-critic
  // can't see: alignment, whitespace distribution, "generic AI look".
  const visualCritique = defineTool({
    name: 'pen_visual_critique',
    label: 'VLM Visual Critique (Screenshot)',
    description:
      'Dispatch the VLM (vision) design critic sub-agent. Renders the current canvas to a PNG screenshot, base64-encodes it, and calls a vision LLM with the 8-dimension structured-critique prompt (visual_hierarchy / spacing / color / typography / component_polish / alignment / information_density / overall_professionalism). ' +
      'Returns overall_score 1-10 + per-dimension defects with fixes + top-5 prioritized fixes. ' +
      'Catches what pen_self_critique (text-only) cannot see — alignment, whitespace, "generic AI look".',
    promptSnippet: 'Render canvas → PNG → vision LLM critique (8 dimensions, 1-10 score).',
    promptGuidelines: [
      'Use this after pen_self_critique for an alignment/whitespace pass the text-critic cannot do.',
      'Render is at 1440x900 @ 2x DPI — text renders crisp enough for the VLM to judge typography.',
      'Address every defect whose impact is "high" before declaring done.',
      'If the overall_score is ≤ 4, the design is still wireframe-quality — apply the top-5 fixes and call again.',
    ],
    parameters: Type.Object({
      originalPrompt: Type.Optional(Type.String({ description: 'The original user prompt (for context — the critic should not let it bias the evaluation).' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { dispatchDesignCriticVlmSubAgent } = await import('./subagents/design-critic-vlm');
      const canvas = ctx.getDocument?.() ?? ({
        id: 'vlm-critic-no-doc',
        name: 'Untitled',
        children: [],
        shapes: ctx.getShapes(),
        tokens: ctx.getTokens(),
        background: '#ffffff',
        viewport: { zoom: 1, panX: 0, panY: 0 },
        version: '2.17' as const,
      } as unknown as import('../canvas/types').CanvasDocument);
      const result = await dispatchDesignCriticVlmSubAgent({
        task: 'Critique the rendered canvas.',
        canvas,
        originalPrompt: params.originalPrompt ?? '(no original prompt provided)',
      });
      const critiqueJson = result.critique ? JSON.stringify(result.critique, null, 2) : result.summary;
      return {
        content: [{ type: 'text', text: critiqueJson }],
        details: {
          subAgent: 'design_critic_vlm',
          toolCalls: result.toolCalls,
          success: result.success,
          error: result.error,
          critique: result.critique,
        },
      };
    },
  });

  const recommendComponents = defineTool({
    name: 'pen_recommend_components',
    label: 'Recommend Components',
    description:
      'Scan the canvas for repeated shape patterns (similar type + size + fill) and recommend which shapes should be converted into reusable Components. ' +
      'Returns a list of candidate groups, each with a suggested component name + the shape ids involved. ' +
      'Closes a key gap vs Figma AI: proactively suggests componentization opportunities instead of waiting for the user to ask. ' +
      'Does NOT mutate the canvas — pure analysis. The agent should follow up with `pen_convert_to_component` + `pen_place_component_instance` to act on the recommendations.',
    promptSnippet: 'Find repeated shapes that should become Components.',
    promptGuidelines: [
      'Useful after generating a multi-screen design with repeated UI elements (cards, buttons, list rows).',
      'After getting recommendations, call `pen_convert_to_component` on one of the suggested shapes, then replace its siblings with `pen_place_component_instance`.',
      'Groups with 3+ shapes are the highest-value candidates (componentization pays off when reused).',
    ],
    parameters: Type.Object({
      minGroupSize: Type.Optional(Type.Number({ description: 'Minimum number of similar shapes to recommend as a component (default 2, recommend 3+)', minimum: 2, maximum: 10 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const shapes = ctx.getShapes();
      const minSize = params.minGroupSize ?? 2;

      // Group shapes by similarity: same type + similar size (±10%) + same fill.
      const groups: Array<{
        key: string;
        shapes: Shape[];
        suggestedName: string;
      }> = [];

      const visited = new Set<string>();
      for (const s of shapes) {
        if (visited.has(s.id)) continue;
        if (s.componentId) continue; // Already a component/instance — skip.

        // Find similar shapes.
        const similar = shapes.filter((other) => {
          if (visited.has(other.id)) return false;
          if (other.id === s.id) return true;
          if (other.type !== s.type) return false;
          // Size similarity: ±10% on both width and height.
          const wDiff = Math.abs(other.width - s.width) / Math.max(s.width, 1);
          const hDiff = Math.abs(other.height - s.height) / Math.max(s.height, 1);
          if (wDiff > 0.1 || hDiff > 0.1) return false;
          // Fill similarity (case-insensitive).
          if ((other.fill ?? '').toLowerCase() !== (s.fill ?? '').toLowerCase()) return false;
          return true;
        });

        if (similar.length >= minSize) {
          for (const sm of similar) visited.add(sm.id);
          const key = `${s.type}-${Math.round(s.width)}x${Math.round(s.height)}-${s.fill}`;
          const suggestedName = `${s.type.charAt(0).toUpperCase() + s.type.slice(1)} ${Math.round(s.width)}×${Math.round(s.height)}`;
          groups.push({ key, shapes: similar, suggestedName });
        }
      }

      // Sort by group size (largest first — highest-value candidates).
      groups.sort((a, b) => b.shapes.length - a.shapes.length);

      if (groups.length === 0) {
        return {
          content: [{ type: 'text', text: 'No repeated shape patterns found. The canvas either has all-unique shapes or already uses components.' }],
          details: { groupsFound: 0, shapesAnalyzed: shapes.length },
        };
      }

      const lines: string[] = [];
      lines.push(`Found ${groups.length} candidate group(s) for componentization (${shapes.length} shapes analyzed):`);
      lines.push('');
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        lines.push(`${i + 1}. ${g.suggestedName} (${g.shapes.length} similar shapes, fill ${g.shapes[0].fill})`);
        lines.push(`   Shape ids: ${g.shapes.map((s) => s.id).join(', ')}`);
        lines.push(`   Suggested action: pen_convert_to_component(shapeId: "${g.shapes[0].id}"), then replace the other ${g.shapes.length - 1} with pen_place_component_instance.`);
        lines.push('');
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: {
          groupsFound: groups.length,
          shapesAnalyzed: shapes.length,
          groups: groups.map((g) => ({
            suggestedName: g.suggestedName,
            shapeIds: g.shapes.map((s) => s.id),
            count: g.shapes.length,
          })),
        },
      };
    },
  });

  const searchDesignPatterns = defineTool({
    name: 'pen_search_design_patterns',
    label: 'Search Design Pattern Memory',
    description:
      'Retrieve similar past design patterns from the pattern memory (RAG). ' +
      'Returns the top-k most similar patterns, each with the original prompt, a summary, key parameters, and a similarity score. ' +
      'Implements the Memory agentic pattern — the agent learns from past successes. ' +
      'Use this BEFORE generating a new design to inform style choices, layout direction, and palette selection.',
    promptSnippet: 'Find similar past designs in the pattern memory.',
    promptGuidelines: [
      'Call this BEFORE generating when the user asks for something similar to past work (e.g. "another dashboard like last time").',
      'Inject the retrieved patterns into your reasoning — they suggest palettes, layouts, and patterns the user has approved before.',
      'If no patterns are returned (empty memory), proceed with your default strategy.',
      'After a successful design + user approval, call `pen_save_design_pattern` to add the new design to the memory.',
    ],
    parameters: Type.Object({
      queryPrompt: Type.Optional(Type.String({ description: 'The query to search for (defaults to the current user prompt). Use natural language describing what you want to find.' })),
      topK: Type.Optional(Type.Number({ description: 'Max patterns to return (default 3, max 10)', minimum: 1, maximum: 10 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { retrieveSimilarPatterns, formatPatternsForPrompt } = await import('./pattern-memory');
      const query = params.queryPrompt ?? '(current prompt)';
      const k = params.topK ?? 3;
      const patterns = await retrieveSimilarPatterns(query, k);
      const formatted = formatPatternsForPrompt(patterns);
      const header = patterns.length > 0
        ? `Retrieved ${patterns.length} similar design pattern(s) from memory (query: "${query.slice(0, 80)}${query.length > 80 ? '…' : ''}"):`
        : `No similar patterns found in memory for query: "${query}". The memory may be empty — use pen_save_design_pattern after a successful design to populate it.`;
      return {
        content: [{ type: 'text', text: `${header}\n\n${formatted}` }],
        details: {
          query,
          topK: k,
          patternsFound: patterns.length,
          patterns: patterns.map((p) => ({
            id: p.id,
            category: p.category,
            summary: p.summary,
            score: p.score,
            createdAt: p.createdAt,
          })),
        },
      };
    },
  });

  const saveDesignPattern = defineTool({
    name: 'pen_save_design_pattern',
    label: 'Save Design to Pattern Memory',
    description:
      'Store the current design as a pattern in the pattern memory for future retrieval. ' +
      'Call this AFTER a successful design generation (especially when the user expresses approval). ' +
      'The stored pattern includes the original prompt, a summary of what was built, the category, and key parameters. ' +
      'Future calls to `pen_search_design_patterns` will retrieve this pattern when a similar prompt is given.',
    promptSnippet: 'Save the current design to the pattern memory.',
    promptGuidelines: [
      'Call this when the user says "good", "perfect", "save this", or otherwise approves a design.',
      'The `summary` field should be 1-3 sentences capturing the key design choices (palette, layout, typography).',
      'The `parameters` field should list the key design tokens / dimensions chosen (e.g. ["palette=violet", "spacing=8px", "radius=6px"]).',
    ],
    parameters: Type.Object({
      summary: Type.String({ description: 'A 1-3 sentence summary of what was built (e.g. "Mobile login screen with social sign-in buttons, violet accent, 24px spacing")' }),
      category: Type.String({ description: 'The design category (e.g. "wireframe", "dashboard", "landing-page", "mobile-app", "component-set")' }),
      parameters: Type.Optional(Type.Array(Type.String(), { description: 'Key design parameters as key=value strings (e.g. ["palette=violet", "spacing=8px"])' })),
      userApproved: Type.Optional(Type.Boolean({ description: 'Whether the user explicitly approved (true) or this is an auto-save (false, default)' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { storeDesignPattern } = await import('./pattern-memory');
      // Pull the current prompt from the context if available (best-effort).
      const prompt = (ctx as { lastPrompt?: string }).lastPrompt ?? '(unknown prompt)';
      const pattern = await storeDesignPattern({
        prompt,
        summary: params.summary,
        category: params.category,
        parameters: params.parameters ?? [],
        userApproved: params.userApproved ?? false,
      });
      return {
        content: [{ type: 'text', text: `Saved design pattern (id: ${pattern.id}, category: ${pattern.category}). It will be retrieved by future pen_search_design_patterns calls when a similar prompt is given.` }],
        details: { patternId: pattern.id, createdAt: pattern.createdAt },
      };
    },
  });

  const clearPatternMemory = defineTool({
    name: 'pen_clear_pattern_memory',
    label: 'Clear Pattern Memory',
    description:
      'Wipe ALL stored design patterns from the pattern memory. ' +
      'Use this when the user wants to "forget" past designs and start fresh (e.g. they pivoted to a different design style). ' +
      'Returns the count of deleted patterns. This action is irreversible.',
    promptSnippet: 'Wipe the design-pattern memory.',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const { clearAllPatterns } = await import('./pattern-memory');
      const count = await clearAllPatterns();
      return {
        content: [{ type: 'text', text: `Cleared ${count} pattern(s) from the design-pattern memory.` }],
        details: { deletedCount: count },
      };
    },
  });

  const patternStats = defineTool({
    name: 'pen_pattern_stats',
    label: 'Pattern Memory Stats',
    description:
      'Inspect the design-pattern memory store: how many patterns are stored, oldest/newest timestamps. ' +
      'Useful for debugging or for the user to see how much the agent has "learned".',
    promptSnippet: 'Get stats about the design-pattern memory.',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const { getPatternStats } = await import('./pattern-memory');
      const stats = await getPatternStats();
      const lines: string[] = [`Pattern memory stats:`];
      lines.push(`  Total patterns: ${stats.count}`);
      if (stats.oldest) lines.push(`  Oldest: ${new Date(stats.oldest).toISOString()}`);
      if (stats.newest) lines.push(`  Newest: ${new Date(stats.newest).toISOString()}`);
      if (stats.count === 0) {
        lines.push('  (Memory is empty. Use pen_save_design_pattern after a successful design to populate it.)');
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: stats,
      };
    },
  });

  return [
    // Core
    createShape,
    updateShape,
    deleteShape,
    // (pen_list_shapes folded into getMetadata — G.3 supersede row; legacy
    //  name resolves via the alias registry with a migration notice.)
    clearCanvas,
    setBackground,
    selectShape,
    // Layer org
    duplicateShape,
    groupShapes,
    ungroupShapes,
    reparentShape,
    alignShapes,
    organizeLayers,
    // Auto layout
    applyAutoLayout,
    // Components (pen_create_component itself now lives in figma-tools.ts —
    // the Figma-shaped fold target per G.3; see the comment above.)
    instantiateComponent,
    // Component System (Phase 2 — Figma-aligned components & design systems)
    convertToComponent,
    placeComponentInstance,
    overrideInstance,
    resetInstance,
    detachInstance,
    combineAsVariants,
    swapVariant,
    // Tokens / palette
    updateTokens,
    applyPalette,
    generatePalette,
    // Generators
    generateWireframe,
    generateUserFlow,
    generateDiagram,
    // Analysis (heatmap tool removed for .pen purity)
    generateCopy,
    auditDesign,
    // Phase 1a: Token binding
    bindShapeToToken,
    unbindShape,
    listTokens,
    applyToken,
    // Phase 1b: Lock & visibility
    setLocked,
    setVisible,
    // Phase 1c: Z-order
    bringToFront,
    sendToBack,
    moveForward,
    moveBackward,
    reorderShape,
    // Figma hierarchy: layout constraints (reparent is in Layer org above)
    setConstraints,
    // Phase 2a: Undo / redo
    undoCanvas,
    redoCanvas,
    // Phase 2b: Export
    exportJson,
    exportSvg,
    exportPng,
    copyAsCode,
    // Phase 3 (spec §5.2): Figma-MCP-aligned tools
    insertHtml,
    getMetadata,
    getVariableDefs,
    getDesignContext,
    bakeLayout,
    getComputed,
    getScreenshot,
    // Phase 2c: Find & filter
    findShapes,
    bulkUpdateByFilter,
    findReplaceText,
    // Phase 5a: Vector editing
    createPath,
    booleanOp,
    maskWith,
    // Phase 5b: Effects & styling
    setGradientFill,
    setShadow,
    setBlur,
    setCornerRadiusPerCorner,
    // Phase 5c: Image support
    uploadImage,
    searchIcons,
    generateImage,
    // Web research (zero-config, no API key)
    webSearchTool,
    webFetchTool,
    // Agentic workflows (Phase 3 — emerging patterns: reflection, memory, RAG)
    selfCritique,
    recommendComponents,
    searchDesignPatterns,
    saveDesignPattern,
    clearPatternMemory,
    patternStats,
    // Task 7-c — UI QUALITY ENFORCEMENT tools
    generateDesignBrief,    // T1: pre-generation design brief
    visualCritique,         // T3: VLM screenshot critique
  ];
}

// ---- Convert Pi tools → OpenAI tool spec -----------------------------------
//
// The Pi Agent SDK normally drives tools through `pi-ai` provider adapters.
// In this sandbox we don't have Anthropic/OpenAI keys, so we run the agent
// via `z-ai-web-dev-sdk` (which speaks the OpenAI tool-calling format).
// This helper converts our TypeBox-defined Pi tools into the JSON-schema
// tool spec that the LLM expects.

import { Value } from '@sinclair/typebox/value';

export interface OpenAIToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

export function toolsToOpenAISpec(tools: ReturnType<typeof createCanvasTools>): OpenAIToolSpec[] {
  const canonical = tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      // TypeBox schemas ARE JSON-schema, so we can pass them through after
      // cleaning up any TypeBox-specific symbols.
      parameters: Value.Clean(t.parameters, {}) as object,
    },
  }));
  // Spec Phase 6 part 2 (§9.3 #4): expose BOTH vocabularies during the
  // deprecation window — the LLM sees the canonical tools plus the legacy
  // aliases (deprecated-prefixed), so old-vocabulary calls still land.
  const aliases = aliasToolEntries(tools as unknown as AliasToolLike[]).map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: Value.Clean((t as any).parameters, {}) as object,
    },
  }));
  return [...canonical, ...aliases];
}

// ---- Execute a tool by name -------------------------------------------------
//
// Extended with per-tool response token caps (Tier 1). Claude Code defaults
// to 25,000 tokens per tool response; we cap at MAX_TOOL_RESULT_CHARS
// (~25K chars ≈ 6K tokens) to prevent context bloat on list/audit/export
// tools that can produce very large outputs.

/// Maximum characters a tool result can return before truncation.
/// ~25K chars ≈ 6K tokens. Mirrors Claude Code's 25K-token default cap.
export const MAX_TOOL_RESULT_CHARS = 25_000;

export async function executeTool(
  tools: ReturnType<typeof createCanvasTools>,
  toolName: string,
  args: any,
): Promise<{ content: string; patch?: CanvasPatch; patches?: CanvasPatch[]; isError?: boolean }> {
  // Spec Phase 6 part 2 (§9.3 #4): resolve legacy tool names to their
  // canonical successors. Unknown names still error exactly as before
  // (resolveToolName passes them through — never silently resolve).
  const { name: canonicalName, aliasOf } = resolveToolName(toolName);
  const tool = tools.find((t) => t.name === canonicalName);
  if (!tool) {
    return { content: `Unknown tool: ${toolName}`, isError: true };
  }

  // ---- Argument repair (poka-yoke) ----------------------------------------
  // The LLM occasionally passes array parameters as stringified JSON strings
  // (e.g. palette="[\"#fff\",\"#000\"]" instead of ["#fff","#000"]). This is
  // a known failure mode with large tool registries (see worklog.md
  // assess-skills task). We detect and repair it here so the tool doesn't
  // crash with "Cannot read properties of undefined (reading 'includes')".
  // (normalizeToolParams folds legacy param spellings — shapeIds etc. — onto
  // the canonical names FIRST, so the repair lists cover both vocabularies.)
  const repairedArgs = repairArrayArgs(normalizeToolParams(canonicalName, args));

  try {
    const result = await tool.execute(
      `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      repairedArgs,
      undefined,
      undefined,
      undefined as any,
    );
    let text = result.content.map((c: any) => c.text ?? '').join('\n');
    const details = (result.details as any) ?? {};
    const patch = details.patch as CanvasPatch | undefined;
    const patches = Array.isArray(details.patches) ? details.patches as CanvasPatch[] : undefined;
    const isError = (result as any).isError === true;

    // ---- Response token cap (Tier 1) ----------------------------------------
    // Truncate overly long tool results to prevent context bloat across
    // multi-step turns. List/audit/export tools can return 50K+ chars.
    if (text.length > MAX_TOOL_RESULT_CHARS) {
      const truncated = text.slice(0, MAX_TOOL_RESULT_CHARS);
      const remainingLines = text.slice(MAX_TOOL_RESULT_CHARS).split('\n').length;
      text = truncated + `\n\n…[truncated: ${remainingLines} more lines omitted. Refine your query or use a filter to see specific results.]`;
    }

    // Spec Phase 6 part 2: a legacy-name call appends the one-line migration
    // notice AFTER truncation so it always survives — the model learns the
    // canonical spelling mid-session.
    if (aliasOf) {
      text += `\n${deprecationNotice(toolName, aliasOf)}`;
    }

    return { content: text, patch, patches, isError };
  } catch (err: any) {
    return { content: `Tool execution failed: ${err.message}`, isError: true };
  }
}

/// Repair arguments where the LLM passed an array as a stringified JSON string.
///
/// Known-affected parameters (from the assess-skills test):
///   - palette (pen_apply_palette, pen_generate_palette)
///   - shapeIds (pen_align_shapes, pen_group_shapes, etc.)
///   - nodes (pen_generate_diagram)
///   - updates (pen_bulk_update_by_filter)
///   - stops (pen_set_gradient_fill)
///   - points (pen_create_path)
///
/// For each of these, if the value is a string that looks like a JSON array,
/// parse it into a real array.
function repairArrayArgs(args: any): any {
  if (!args || typeof args !== 'object') return args;
  const repaired = { ...args };

  // True array params — accept either a real array OR a stringified JSON array.
  // The LLM occasionally passes `palette="[\"#fff\",\"#000\"]"` instead of
  // `palette=["#fff","#000"]`. Detect + parse.
  const arrayParams = ['palette', 'shapeIds', 'nodeIds', 'nodes', 'updates', 'stops', 'points', 'axes', 'componentIds', 'parameters', 'modes'];
  for (const param of arrayParams) {
    const val = (repaired as any)[param];
    if (typeof val === 'string' && val.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed)) {
          (repaired as any)[param] = parsed;
        }
      } catch {
        // Not valid JSON — leave as-is and let the tool handle the error.
      }
    }
  }

  // String params that the LLM sometimes wraps in a stringified JSON array.
  // Example: shapeId="[\"abc-123\"]" (the LLM got confused because some
  // tools take `shapeIds` plural). Unwrap to the first element.
  // This was the root cause of the "no shape with id [\"abc\"]" loop where
  // the agent retried the same failing call 16+ times.
  const stringParams = ['shapeId', 'nodeId', 'instanceId', 'variantComponentId', 'parentId', 'groupId', 'newParentId', 'maskId', 'variableId', 'collectionId'];
  for (const param of stringParams) {
    const val = (repaired as any)[param];
    if (typeof val === 'string' && val.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
          (repaired as any)[param] = parsed[0];
        }
      } catch {
        // Not valid JSON — leave as-is.
      }
    }
  }

  return repaired;
}

// ---- Wireframe / user-flow / diagram builders ------------------------------
//
// Pure functions that emit arrays of partial shapes. Used by the
// generate_wireframe / generate_user_flow / generate_diagram tools.
// Kept deterministic so the LLM can predict their output.

interface WireframeResult {
  frameId: string;
  shapes: Array<Partial<Shape> & { id: string }>;
}

/// High-fidelity styling palette used by the post-processing pass.
interface HifiPalette {
  PRIMARY: string;
  ACCENT: string;
  SURFACE: string;
  GRAY: string;
}

/// Upgrade a list of wireframe-template shapes to high-fidelity output.
///
/// This runs after every `buildWireframe` template. It scans each shape's
/// NAME (Figma-style names like "Card / Revenue", "Primary Button", "Hero",
/// "CTA", "FAB", "Avatar", "Input / Email") and applies:
///   - Drop shadows on elevated surfaces (cards, buttons, FABs, popovers).
///   - A gradient fill on hero/CTA/logo shapes (primary → accent).
///   - Pill radii (9999) on avatars/toggles/chips.
///   - Larger radii on cards (12) and modals (16) if they were 0.
///   - Primary-color fill on shapes named "Primary Button" / "CTA".
///   - **Typography fields (Task 7-c P1.1):** fontWeight, letterSpacing,
///     lineHeight, textAlign, fontFamily on every text shape based on its
///     semantic role. This is the SINGLE HIGHEST-LEVERAGE FIX because the
///     Task 7-a VLM baseline proved 0% typography usage across 24 text
///     shapes — the wireframe generator emits bare text shapes, the agent
///     follows up with `pen_set_shadow` / `pen_set_gradient_fill` but never
///     sets fontWeight/letterSpacing/textAlign. By emitting them here, even
///     a bare `pen_generate_wireframe` call produces typographically-rich
///     output. The post-processor pattern-matches on shape NAMES, which
///     every template already uses semantically ("Hero heading", "Page
///     title", "Stat 1 value", "Stat 1 label", "Chart title", etc.).
///   - **autoLayout (Task 7-c P1.1):** added to layout containers (cards,
///     sidebars, topbars, tab bars) so child shapes align automatically.
///
/// This guarantees that even a bare `pen_generate_wireframe` call produces
/// a visually polished starting point — not a flat grayscale wireframe.
/// The LLM is still expected to follow up with pen_apply_palette, more
/// shadows, real copy, etc., but the scaffold is no longer an embarrassment.
function applyHighFidelityStyling(
  shapes: Array<Partial<Shape> & { id: string }>,
  palette: HifiPalette,
): void {
  const { PRIMARY, ACCENT } = palette;
  // Card shadow — Task 8-a (VLM fix #2): subtle resting elevation,
  // 0 1px 2px rgba(0,0,0,0.05). The old 4px-y Material shadow read as
  // "heavy wireframe drop-shadow"; this is the modern fintech card look.
  const SHADOW_CARD = { x: 0, y: 1, blur: 2, color: '#0000000d', spread: 0, inset: false };
  // Soft button shadow (Material 1dp-ish): 0 2 4 -1 rgba(0,0,0,0.10)
  const SHADOW_BUTTON = { x: 0, y: 2, blur: 4, color: '#0000001a', spread: -1, inset: false };
  // FAB / modal shadow (Material 8dp-ish): 0 8 12 -4 rgba(0,0,0,0.20)
  const SHADOW_FAB = { x: 0, y: 8, blur: 12, color: '#00000033', spread: -4, inset: false };

  for (const s of shapes) {
    const name = (s.name ?? '').toLowerCase();

    // Skip the frame itself — it already got a shadow in addFrame.
    if (s.type === 'frame' && s.id === shapes[0]?.id) continue;

    // --- Typography fields (Task 7-c P1.1 — highest-impact fix) ------------
    // Apply per-role typography to text shapes based on their semantic name.
    // The system prompt's LETTER SPACING RULES table is honored here:
    //   - DISPLAY / hero (≥38px):    weight 700, letterSpacing -0.8
    //   - H1 / page title:           weight 700, letterSpacing -0.6, size 28-32
    //   - H2 / section heading:      weight 600, letterSpacing -0.4, size 18-22
    //   - Metric value (big number):  weight 700, letterSpacing -0.5, left align
    //   - Metric / stat label:        weight 500, letterSpacing +0.6, left align
    //   - Body / paragraph:           weight 400, letterSpacing 0, lineHeight 1.5
    //   - Table header:               weight 600, letterSpacing +0.5, uppercase
    //   - Button label:               weight 500-600, letterSpacing +0.3, center
    //   - Input placeholder/label:    weight 400, letterSpacing 0, left
    //   - Sidebar nav item:           weight 500, letterSpacing 0, left
    //   - Caption / overline:         weight 500, letterSpacing +0.4-0.8
    // The renderer (Canvas.tsx ShapeRenderer case 'text') honors fontWeight,
    // letterSpacing, lineHeight, textAlign, fontFamily — so these fields flow
    // through .pen PenTextStyle → resolvePenTree → Layer → SVG <text>.
    if (s.type === 'text') {
      applyTypographyByName(s, name);
    }

    // --- Cards: subtle shadow + 1px border + radius >= 12 + autoLayout ---
    // Task 8-a (VLM fix #2): every card-shaped rect gets the full modern
    // treatment — radius 12, 1px #e2e8f0 border, 0 1px 2px 5% shadow.
    if (/\bcard\b|\bstat\b|\bchart\b|\bpanel\b|\btile\b|\bitem\b|\bproduct\b/.test(name) && s.type === 'rectangle') {
      if (!s.shadow) s.shadow = SHADOW_CARD;
      if (!s.radius || s.radius < 12) s.radius = 12;
      if (!s.stroke || s.stroke === 'transparent') s.stroke = palette.GRAY;
      if (!s.strokeWidth) s.strokeWidth = 1;
      // Cards/panels with content children benefit from vertical autoLayout.
      // Note: the wireframe templates lay out text via absolute coordinates,
      // so we set autoLayout only as a marker — the renderer doesn't yet
      // reflow children, but the layer is "auto-layout aware" for the agent's
      // follow-up calls.
      if (!s.autoLayout) {
        s.autoLayout = {
          direction: 'vertical',
          gap: 8,
          padding: 16,
          alignX: 'min',
          alignY: 'min',
        };
      }
    }

    // --- Buttons: add shadow, primary fill, white text, pill-ish radius ---
    if (/\bbutton\b|\bcta\b|\baction\b|\bsubmit\b|\bsign\s*in\b|\bcontinue\b|\bbuy\b|\badd\b|\bprimary\b/.test(name) && s.type === 'rectangle') {
      if (!s.shadow) s.shadow = SHADOW_BUTTON;
      // Only recolor if it looks like a placeholder (gray/light fill or no fill).
      const fill = s.fill ?? '';
      if (!fill || fill === '#e2e8f0' || fill === '#f1f5f9' || fill === '#ffffff' || fill === 'transparent') {
        s.fill = PRIMARY;
        s.textColor = '#ffffff';
        s.fontSize = s.fontSize || 16;
        if (!s.radius || s.radius < 8) s.radius = 10;
      }
    }

    // --- FAB: floating action button — bigger shadow, primary fill, pill ---
    if (/\bfab\b|\bfloating\b/.test(name)) {
      if (!s.shadow) s.shadow = SHADOW_FAB;
      s.fill = PRIMARY;
      s.radius = 9999;
    }

    // --- Avatars / profile circles: pill radius ---
    if (/\bavatar\b|\bprofile\s*pic\b|\buser\s*photo\b/.test(name)) {
      s.radius = 9999;
    }

    // --- Hero / CTA / Logo: gradient fill (primary → accent) ---
    if (/\bhero\b|\bcta\b|\blogo\b|\bbrand\b|\bbanner\b|\bheader\s*bg\b|\bapp\s*bar\b/.test(name) && s.type === 'rectangle') {
      // Only add gradient if not already set; don't overwrite a real image.
      if (!s.gradient && !s.src) {
        s.gradient = {
          type: 'linear',
          angle: 135,
          stops: [
            { offset: 0, color: PRIMARY },
            { offset: 1, color: ACCENT },
          ],
        };
        s.fill = PRIMARY; // fallback solid color (renderer uses gradient if present)
      }
    }

    // --- Bottom tab bar: shadow + surface fill ---
    if (/\btab\s*bar\b|\bbottom\s*nav\b|\bnavbar\b/.test(name) && s.type === 'rectangle') {
      if (!s.shadow) s.shadow = { x: 0, y: -2, blur: 8, color: '#0000001a', spread: 0, inset: false };
      s.fill = '#ffffff';
      if (!s.radius || s.radius < 16) s.radius = 0; // tab bars are usually flat-bottomed
      // Tab bars are horizontal layout containers for icon+label groups.
      if (!s.autoLayout) {
        s.autoLayout = {
          direction: 'horizontal',
          gap: 0,
          padding: 8,
          alignX: 'center',
          alignY: 'center',
        };
      }
    }

    // --- Sidebar: vertical autoLayout (nav items stack) ---
    if (/\bsidebar\b|\bnav\s*drawer\b|\bside\s*nav\b/.test(name) && s.type === 'rectangle') {
      if (!s.autoLayout) {
        s.autoLayout = {
          direction: 'vertical',
          gap: 4,
          padding: 16,
          alignX: 'min',
          alignY: 'min',
        };
      }
    }

    // --- Topbar / nav / header: horizontal autoLayout (logo + nav + actions) ---
    if (/\btopbar\b|\btop\s*bar\b|\bheader\b|\bnav\s*bar\b|\bapp\s*bar\b/.test(name) && s.type === 'rectangle') {
      if (!s.autoLayout) {
        s.autoLayout = {
          direction: 'horizontal',
          gap: 16,
          padding: 16,
          alignX: 'min',
          alignY: 'center',
        };
      }
    }

    // --- Input fields: ensure they have a visible border + 8px radius ---
    if (/\binput\b|\bfield\b|\bemail\b|\bpassword\b|\bsearch\s*bar\b/.test(name) && s.type === 'rectangle') {
      if (!s.stroke || s.stroke === 'transparent') s.stroke = palette.GRAY;
      if (!s.strokeWidth) s.strokeWidth = 1;
      if (!s.radius || s.radius < 8) s.radius = 8;
    }

    // --- Chart bars: rounded tops (Task 8-a / VLM fix #2) -----------------
    // Modern chart bars round ONLY their top corners. The renderer
    // approximates per-corner radii with a uniform rx, so we emit radii
    // {top:4, bottom:0} — rendered as a gentle 4px rounding that reads as
    // "rounded top" without the harsh square wireframe look.
    // NOTE: deliberately does NOT match "tab bar" / "navbar" / "search bar"
    // / "app bar" — those are flat navigation chrome, not data bars.
    if (/\bchart\s*bar\b|\bbar\s*chart\b|\bbar\s*\d\b|\bvalue\s*bar\b|\bdata\s*bar\b/.test(name) && s.type === 'rectangle' && !s.radii) {
      s.radii = { topLeft: 4, topRight: 4, bottomRight: 0, bottomLeft: 0 };
      if (!s.radius) s.radius = 4;
    }
  }
}

/// Apply per-role typography fields to a text shape based on its semantic name.
///
/// Honors the system prompt's LETTER SPACING RULES table. The shape is mutated
/// in place — only fields not already set by the template are filled, so the
/// agent's follow-up `pen_update_node` calls (e.g. to change the brand name's
/// text) won't be overwritten.
///
/// Naming patterns cover every text shape the wireframe templates emit:
///   - Page title / Hero heading / Headline → H1 (28px / 700 / -0.6)
///   - Section heading / Subhead / Subheading → H2 (18px / 600 / -0.4)
///   - Stat value / Metric value (large number) → 32px / 700 / -0.5 / left
///   - Stat label / Metric label / Overline → 12px / 500 / +0.6 / left
///   - Body text / Excerpt / Paragraph → 14-16px / 400 / 0 / 1.5
///   - Table header / Column header → 11px / 600 / +0.5 / left (UPPERCASE intent)
///   - Button label / CTA label / Sign in label → 14px / 600 / +0.3 / center
///   - Input label / placeholder → 13-14px / 400 / 0 / left
///   - Nav item / Sidebar item / Tab label → 13px / 500 / 0 / left
///   - Caption / helper / footer / fine print → 12px / 400 / +0.2
function applyTypographyByName(
  s: Partial<Shape> & { id: string },
  name: string,
): void {
  // Page title / hero heading / wordmark — H1 (28-32px / 700 / -0.6 / left)
  if (
    /\bpage\s*title\b|\bhero\s*heading\b|\bhero\s*title\b|\bheadline\b|\bwordmark\b|\bbrand\s*name\b|\bpage\s*heading\b|\bapp\s*name\b/.test(name)
  ) {
    if (s.fontWeight === undefined) s.fontWeight = 700;
    if (s.letterSpacing === undefined) s.letterSpacing = -0.6;
    if (s.textAlign === undefined) s.textAlign = 'left';
    if (s.fontFamily === undefined) s.fontFamily = 'Inter, system-ui, sans-serif';
    if (s.lineHeight === undefined) s.lineHeight = 1.2;
    return;
  }
  // Section heading / subhead / subheading / panel title / chart title → H2 (18px / 600 / -0.4)
  if (
    /\bsection\s*head|\bsubhead|\bsubheading|\bpanel\s*title|\bchart\s*title|\bcard\s*title|\bmodule\s*title|\bwidget\s*title|\bgroup\s*title/.test(name)
  ) {
    if (s.fontWeight === undefined) s.fontWeight = 600;
    if (s.letterSpacing === undefined) s.letterSpacing = -0.4;
    if (s.textAlign === undefined) s.textAlign = 'left';
    if (s.fontFamily === undefined) s.fontFamily = 'Inter, system-ui, sans-serif';
    if (s.lineHeight === undefined) s.lineHeight = 1.25;
    return;
  }
  // Stat / metric value — large number (700 / -0.5 / left for tabular scanning)
  // Matches: "Stat 1 value", "Metric value", "KPI value", "Revenue value".
  // Task 8-a (VLM fix #4): default 32px so agent-created metric values land
  // in the 32-36px / 700 / -0.5 tabular-numbers range.
  if (
    /\bstat\s*\d*\s*value|\bmetric\s*value|\bkpi\s*value|\bstat\s*value|\bvalue\s*\d|\bbig\s*number|\bmetric\s*num|\bstat.*amount/.test(name)
  ) {
    if (s.fontWeight === undefined) s.fontWeight = 700;
    if (s.letterSpacing === undefined) s.letterSpacing = -0.5;
    if (s.textAlign === undefined) s.textAlign = 'left';
    if (s.fontFamily === undefined) s.fontFamily = 'Inter, system-ui, sans-serif';
    if (s.lineHeight === undefined) s.lineHeight = 1.1;
    if (s.fontSize === undefined) s.fontSize = 32;
    return;
  }
  // Stat / metric label / overline — small caps label (12px / 500 / +0.6 / left)
  // Matches: "Stat 1 label", "Metric label", "KPI label", "Overline".
  // Task 8-a (VLM fix #4): default 12px; write the label CONTENT in UPPERCASE.
  if (
    /\bstat\s*\d*\s*label|\bmetric\s*label|\bkpi\s*label|\bstat\s*label|\boverline|\blabel\b/.test(name)
  ) {
    if (s.fontWeight === undefined) s.fontWeight = 500;
    if (s.letterSpacing === undefined) s.letterSpacing = 0.6;
    if (s.textAlign === undefined) s.textAlign = 'left';
    if (s.fontFamily === undefined) s.fontFamily = 'Inter, system-ui, sans-serif';
    if (s.lineHeight === undefined) s.lineHeight = 1.4;
    if (s.fontSize === undefined) s.fontSize = 12;
    return;
  }
  // Button / CTA label — center-aligned, medium-bold (14px / 600 / +0.3 / center)
  if (
    /\bbutton\s*label|\bcta\s*label|\baction\s*label|\bsign\s*in\s*label|\bcontinue\s*label|\bsubmit\s*label|\bbuy\s*label|\badd\s*label|\bbtn\s*label|\bprimary\s*cta\s*label/.test(name)
  ) {
    if (s.fontWeight === undefined) s.fontWeight = 600;
    if (s.letterSpacing === undefined) s.letterSpacing = 0.3;
    if (s.textAlign === undefined) s.textAlign = 'center';
    if (s.fontFamily === undefined) s.fontFamily = 'Inter, system-ui, sans-serif';
    if (s.lineHeight === undefined) s.lineHeight = 1.2;
    return;
  }
  // Table / column header — uppercase small caps (11px / 600 / +0.5 / left)
  if (
    /\btable\s*header|\bcolumn\s*header|\bcol\s*header|\bheader\s*cell/.test(name)
  ) {
    if (s.fontWeight === undefined) s.fontWeight = 600;
    if (s.letterSpacing === undefined) s.letterSpacing = 0.5;
    if (s.textAlign === undefined) s.textAlign = 'left';
    if (s.fontFamily === undefined) s.fontFamily = 'Inter, system-ui, sans-serif';
    if (s.lineHeight === undefined) s.lineHeight = 1.3;
    if (s.fontSize === undefined) s.fontSize = 11;
    return;
  }
  // Nav / sidebar / tab labels — medium weight, left (13px / 500 / 0)
  if (
    /\bnav\s*item|\bsidebar\s*logo|\bsidebar\s*item|\btab\s*\d*\s*label|\btab\s*label|\bnav\s*label|\bmenu\s*item|\bmenu\s*label/.test(name)
  ) {
    if (s.fontWeight === undefined) s.fontWeight = 500;
    if (s.letterSpacing === undefined) s.letterSpacing = 0;
    if (s.textAlign === undefined) s.textAlign = 'left';
    if (s.fontFamily === undefined) s.fontFamily = 'Inter, system-ui, sans-serif';
    if (s.lineHeight === undefined) s.lineHeight = 1.4;
    return;
  }
  // Input / field label / placeholder — light (13-14px / 400 / 0 / left)
  if (
    /\binput\s*label|\bfield\s*label|\bemail\s*label|\bpassword\s*label|\bplaceholder|\binput\s*text|\bsearch\s*placeholder/.test(name)
  ) {
    if (s.fontWeight === undefined) s.fontWeight = 400;
    if (s.letterSpacing === undefined) s.letterSpacing = 0;
    if (s.textAlign === undefined) s.textAlign = 'left';
    if (s.fontFamily === undefined) s.fontFamily = 'Inter, system-ui, sans-serif';
    if (s.lineHeight === undefined) s.lineHeight = 1.4;
    return;
  }
  // Caption / footer / fine print / helper — small (12px / 400 / +0.2)
  if (
    /\bcaption|\bfooter|\bfine\s*print|\bhelper|\bdisclaimer|\bhint|\bsub\s*note/.test(name)
  ) {
    if (s.fontWeight === undefined) s.fontWeight = 400;
    if (s.letterSpacing === undefined) s.letterSpacing = 0.2;
    if (s.textAlign === undefined) s.textAlign = 'left';
    if (s.fontFamily === undefined) s.fontFamily = 'Inter, system-ui, sans-serif';
    if (s.lineHeight === undefined) s.lineHeight = 1.4;
    return;
  }
  // Link / forgot password / sign in link — primary-colored link text (13-14px / 500 / 0)
  if (
    /\blink|\bforgot\s*password|\bsign\s*up\s*link|\bsign\s*in\s*link|\balready\s*have\s*an\s*account/.test(name)
  ) {
    if (s.fontWeight === undefined) s.fontWeight = 500;
    if (s.letterSpacing === undefined) s.letterSpacing = 0;
    if (s.textAlign === undefined) s.textAlign = 'left';
    if (s.fontFamily === undefined) s.fontFamily = 'Inter, system-ui, sans-serif';
    if (s.lineHeight === undefined) s.lineHeight = 1.4;
    return;
  }
  // Amount cells — right-aligned tabular numerals (14px / 500 / 0 / right).
  // Task 8-a (DATA TABLE recipe): the amount column is right-aligned so the
  // digits line up in a scannable column. Matches "Transaction 1 amount".
  if (/\bamount\b/.test(name)) {
    if (s.fontWeight === undefined) s.fontWeight = 500;
    if (s.letterSpacing === undefined) s.letterSpacing = 0;
    if (s.textAlign === undefined) s.textAlign = 'right';
    if (s.fontFamily === undefined) s.fontFamily = 'Inter, system-ui, sans-serif';
    if (s.lineHeight === undefined) s.lineHeight = 1.3;
    return;
  }
  // Body / excerpt / paragraph / description / hero subheading — default body
  // (14-16px / 400 / 0 / 1.5)
  if (
    /\bbody|\bexcerpt|\bparagraph|\bdescription|\bsubhead|\bsubheading|\bhero\s*subheading|\bhero\s*sub|\bsubtitle|\bcontent\b|\btext\b/.test(name)
  ) {
    if (s.fontWeight === undefined) s.fontWeight = 400;
    if (s.letterSpacing === undefined) s.letterSpacing = 0;
    if (s.textAlign === undefined) s.textAlign = 'left';
    if (s.fontFamily === undefined) s.fontFamily = 'Inter, system-ui, sans-serif';
    if (s.lineHeight === undefined) s.lineHeight = 1.5;
    return;
  }
  // Catch-all for any other text shape: at least set the font family + a
  // sensible default weight so it doesn't render as bare default 400.
  if (s.fontFamily === undefined) s.fontFamily = 'Inter, system-ui, sans-serif';
  if (s.lineHeight === undefined) s.lineHeight = 1.4;
}

function buildWireframe(template: string, oxIn: number, oyIn: number): WireframeResult {
  // Defensive: coerce to numbers in case the caller passed strings.
  // (Even with the tool-level coercion above, buildWireframe is also called
  // by pen_generate_user_flow which may pass strings.)
  const ox = typeof oxIn === 'number' ? oxIn : Number(oxIn) || 0;
  const oy = typeof oyIn === 'number' ? oyIn : Number(oyIn) || 0;
  const frameId = crypto.randomUUID();
  const shapes: Array<Partial<Shape> & { id: string }> = [];
  // High-fidelity palette (replaces the old grayscale GRAY/DARK/LIGHT constants).
  // These map to the semantic tokens in the system prompt's design system.
  const GRAY = '#e2e8f0';   // $color.border — kept for legacy template refs
  const DARK = '#0f172a';   // $color.text — primary text (was slate-600, now slate-900 for contrast)
  const LIGHT = '#f1f5f9';  // $color.surface-2 — input/nested surfaces
  // New hifi constants used by the post-processing pass + new templates.
  const SURFACE = '#ffffff';     // $color.surface — cards
  const PRIMARY = '#0ea5e9';     // $color.primary — CTAs, active states
  const ACCENT = '#6366f1';      // $color.accent — secondary accent
  const TEXT_MUTED = '#475569';  // $color.text-muted
  const TEXT_SUBTLE = '#94a3b8'; // $color.text-subtle
  const SUCCESS = '#10b981';     // $color.success
  const DANGER = '#ef4444';      // $color.danger
  const add = (s: Partial<Shape> & { id: string }) => shapes.push(s);

  // Helper for a basic frame. High-fidelity: white fill, no harsh stroke,
  // rounded corners (16px for app-like feel), subtle shadow.
  const addFrame = (w: number, h: number, name: string) => {
    add({
      id: frameId,
      type: 'frame',
      name,
      x: ox, y: oy, width: w, height: h,
      fill: SURFACE, stroke: GRAY, strokeWidth: 1, radius: 16,
      fontSize: 16, textColor: DARK,
      shadow: { x: 0, y: 8, blur: 24, color: '#0000001a', spread: -4, inset: false },
    });
  };

  switch (template) {
    case 'mobile_login': {
      addFrame(375, 667, 'Mobile / Login');
      add({ id: crypto.randomUUID(), type: 'text', name: 'Logo', x: ox + 137, y: oy + 80, width: 100, height: 32, fill: 'transparent', text: 'Logo', fontSize: 24, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Heading', x: ox + 32, y: oy + 160, width: 200, height: 28, fill: 'transparent', text: 'Welcome back', fontSize: 22, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Subheading', x: ox + 32, y: oy + 196, width: 250, height: 20, fill: 'transparent', text: 'Sign in to continue', fontSize: 14, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Email field', x: ox + 32, y: oy + 256, width: 311, height: 48, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Email label', x: ox + 48, y: oy + 270, width: 100, height: 16, fill: 'transparent', text: 'Email', fontSize: 13, textColor: '#94a3b8', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Password field', x: ox + 32, y: oy + 320, width: 311, height: 48, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Password label', x: ox + 48, y: oy + 334, width: 100, height: 16, fill: 'transparent', text: 'Password', fontSize: 13, textColor: '#94a3b8', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Sign in button', x: ox + 32, y: oy + 392, width: 311, height: 48, fill: DARK, stroke: 'transparent', strokeWidth: 0, radius: 8, fontSize: 14, textColor: '#ffffff' });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Sign in label', x: ox + 150, y: oy + 410, width: 80, height: 16, fill: 'transparent', text: 'Sign in', fontSize: 14, textColor: '#ffffff', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Forgot password', x: ox + 110, y: oy + 460, width: 160, height: 16, fill: 'transparent', text: 'Forgot password?', fontSize: 13, textColor: '#0ea5e9', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      break;
    }
    case 'mobile_signup': {
      addFrame(375, 667, 'Mobile / Signup');
      add({ id: crypto.randomUUID(), type: 'text', name: 'Heading', x: ox + 32, y: oy + 80, width: 250, height: 28, fill: 'transparent', text: 'Create account', fontSize: 22, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Subheading', x: ox + 32, y: oy + 116, width: 280, height: 20, fill: 'transparent', text: 'Join us in 30 seconds', fontSize: 14, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Name field', x: ox + 32, y: oy + 176, width: 311, height: 48, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Email field', x: ox + 32, y: oy + 240, width: 311, height: 48, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Password field', x: ox + 32, y: oy + 304, width: 311, height: 48, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'CTA button', x: ox + 32, y: oy + 376, width: 311, height: 48, fill: DARK, stroke: 'transparent', strokeWidth: 0, radius: 8, fontSize: 14, textColor: '#ffffff' });
      add({ id: crypto.randomUUID(), type: 'text', name: 'CTA label', x: ox + 130, y: oy + 394, width: 120, height: 16, fill: 'transparent', text: 'Create account', fontSize: 14, textColor: '#ffffff', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Sign in link', x: ox + 90, y: oy + 450, width: 200, height: 16, fill: 'transparent', text: 'Already have an account? Sign in', fontSize: 13, textColor: '#0ea5e9', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      break;
    }
    case 'mobile_welcome': {
      // Onboarding step 1: welcome screen with hero illustration + value prop + CTA.
      addFrame(375, 812, 'Mobile / Onboarding · Welcome');
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Hero image', x: ox + 48, y: oy + 120, width: 279, height: 220, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 16, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Hero icon', x: ox + 165, y: oy + 200, width: 50, height: 50, fill: 'transparent', text: '✨', fontSize: 48, textColor: '#0ea5e9', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Headline', x: ox + 32, y: oy + 380, width: 311, height: 36, fill: 'transparent', text: 'Welcome to Acme', fontSize: 28, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Subhead', x: ox + 32, y: oy + 424, width: 311, height: 48, fill: 'transparent', text: 'The fastest way to ship your product. Get started in under 2 minutes.', fontSize: 15, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Primary CTA', x: ox + 32, y: oy + 540, width: 311, height: 52, fill: '#0ea5e9', stroke: 'transparent', strokeWidth: 0, radius: 12, fontSize: 16, textColor: '#ffffff' });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Primary CTA label', x: ox + 130, y: oy + 558, width: 150, height: 20, fill: 'transparent', text: 'Get started', fontSize: 16, textColor: '#ffffff', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Secondary CTA', x: ox + 100, y: oy + 612, width: 175, height: 20, fill: 'transparent', text: 'I already have an account', fontSize: 14, textColor: '#0ea5e9', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Page dots (1 of 3 active)
      add({ id: crypto.randomUUID(), type: 'ellipse', name: 'Dot 1 (active)', x: ox + 168, y: oy + 720, width: 8, height: 8, fill: '#0ea5e9', stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'ellipse', name: 'Dot 2', x: ox + 184, y: oy + 720, width: 8, height: 8, fill: GRAY, stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'ellipse', name: 'Dot 3', x: ox + 200, y: oy + 720, width: 8, height: 8, fill: GRAY, stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      // Skip link
      add({ id: crypto.randomUUID(), type: 'text', name: 'Skip', x: ox + 310, y: oy + 48, width: 40, height: 20, fill: 'transparent', text: 'Skip', fontSize: 14, textColor: '#94a3b8', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      break;
    }
    case 'mobile_permissions': {
      // Onboarding step 2: permissions screen with toggle list + Allow button.
      addFrame(375, 812, 'Mobile / Onboarding · Permissions');
      add({ id: crypto.randomUUID(), type: 'text', name: 'Headline', x: ox + 32, y: oy + 80, width: 311, height: 32, fill: 'transparent', text: 'Enable features', fontSize: 24, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Subhead', x: ox + 32, y: oy + 120, width: 311, height: 36, fill: 'transparent', text: 'Allow these permissions so we can personalize your experience.', fontSize: 14, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Permission rows
      const perms = [
        { icon: '🔔', title: 'Notifications', sub: 'Get alerts for new activity' },
        { icon: '📍', title: 'Location', sub: 'Personalize content by region' },
        { icon: '📷', title: 'Camera', sub: 'Scan documents and take photos' },
      ];
      for (let i = 0; i < perms.length; i++) {
        const py = oy + 200 + i * 88;
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Perm card ${i + 1}`, x: ox + 24, y: py, width: 327, height: 72, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 12, fontSize: 14, textColor: DARK });
        add({ id: crypto.randomUUID(), type: 'text', name: `Perm ${i + 1} icon`, x: ox + 40, y: py + 22, width: 32, height: 32, fill: 'transparent', text: perms[i].icon, fontSize: 24, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
        add({ id: crypto.randomUUID(), type: 'text', name: `Perm ${i + 1} title`, x: ox + 84, y: py + 18, width: 180, height: 18, fill: 'transparent', text: perms[i].title, fontSize: 15, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
        add({ id: crypto.randomUUID(), type: 'text', name: `Perm ${i + 1} sub`, x: ox + 84, y: py + 40, width: 200, height: 16, fill: 'transparent', text: perms[i].sub, fontSize: 12, textColor: '#94a3b8', stroke: 'transparent', strokeWidth: 0, radius: 0 });
        // Toggle (on for first, off for others — visual variety)
        const toggleOn = i === 0;
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Toggle ${i + 1}`, x: ox + 305, y: py + 26, width: 40, height: 22, fill: toggleOn ? '#10b981' : GRAY, stroke: 'transparent', strokeWidth: 0, radius: 11, fontSize: 14, textColor: DARK });
        add({ id: crypto.randomUUID(), type: 'ellipse', name: `Toggle knob ${i + 1}`, x: toggleOn ? ox + 323 : ox + 309, y: py + 28, width: 18, height: 18, fill: '#ffffff', stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      }
      // Primary CTA
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Primary CTA', x: ox + 32, y: oy + 560, width: 311, height: 52, fill: '#0ea5e9', stroke: 'transparent', strokeWidth: 0, radius: 12, fontSize: 16, textColor: '#ffffff' });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Primary CTA label', x: ox + 100, y: oy + 578, width: 200, height: 20, fill: 'transparent', text: 'Continue', fontSize: 16, textColor: '#ffffff', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Page dots (2 of 3 active)
      add({ id: crypto.randomUUID(), type: 'ellipse', name: 'Dot 1', x: ox + 168, y: oy + 720, width: 8, height: 8, fill: '#0ea5e9', stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'ellipse', name: 'Dot 2 (active)', x: ox + 184, y: oy + 720, width: 8, height: 8, fill: '#0ea5e9', stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'ellipse', name: 'Dot 3', x: ox + 200, y: oy + 720, width: 8, height: 8, fill: GRAY, stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      break;
    }
    case 'mobile_done': {
      // Onboarding step 3: success screen with checkmark + "you're all set" + go-to-app.
      addFrame(375, 812, 'Mobile / Onboarding · Done');
      add({ id: crypto.randomUUID(), type: 'ellipse', name: 'Success circle', x: ox + 137, y: oy + 180, width: 100, height: 100, fill: '#10b981', stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: '#ffffff' });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Checkmark', x: ox + 170, y: oy + 200, width: 40, height: 60, fill: 'transparent', text: '✓', fontSize: 60, textColor: '#ffffff', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Headline', x: ox + 32, y: oy + 340, width: 311, height: 36, fill: 'transparent', text: "You're all set!", fontSize: 28, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Subhead', x: ox + 32, y: oy + 384, width: 311, height: 48, fill: 'transparent', text: 'Your account is ready. Let\'s start building something great.', fontSize: 15, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Primary CTA', x: ox + 32, y: oy + 500, width: 311, height: 52, fill: '#0ea5e9', stroke: 'transparent', strokeWidth: 0, radius: 12, fontSize: 16, textColor: '#ffffff' });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Primary CTA label', x: ox + 110, y: oy + 518, width: 180, height: 20, fill: 'transparent', text: 'Go to dashboard', fontSize: 16, textColor: '#ffffff', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Page dots (3 of 3 active)
      add({ id: crypto.randomUUID(), type: 'ellipse', name: 'Dot 1', x: ox + 168, y: oy + 720, width: 8, height: 8, fill: '#0ea5e9', stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'ellipse', name: 'Dot 2', x: ox + 184, y: oy + 720, width: 8, height: 8, fill: '#0ea5e9', stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'ellipse', name: 'Dot 3 (active)', x: ox + 200, y: oy + 720, width: 8, height: 8, fill: '#0ea5e9', stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      break;
    }
    case 'mobile_browse': {
      // Ecommerce step 1: product browse / search + grid of products.
      addFrame(375, 812, 'Mobile / Shop · Browse');
      add({ id: crypto.randomUUID(), type: 'text', name: 'Headline', x: ox + 32, y: oy + 56, width: 200, height: 28, fill: 'transparent', text: 'Shop', fontSize: 24, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Search bar', x: ox + 32, y: oy + 100, width: 311, height: 40, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 20, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Search placeholder', x: ox + 56, y: oy + 112, width: 200, height: 16, fill: 'transparent', text: 'Search products…', fontSize: 14, textColor: '#94a3b8', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Category chips
      const cats = ['All', 'New', 'Sale', 'Brands'];
      for (let i = 0; i < cats.length; i++) {
        const cx = ox + 32 + i * 78;
        const active = i === 0;
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Chip ${i + 1}`, x: cx, y: oy + 160, width: 66, height: 30, fill: active ? '#0ea5e9' : '#ffffff', stroke: GRAY, strokeWidth: 1, radius: 15, fontSize: 13, textColor: active ? '#ffffff' : DARK });
        add({ id: crypto.randomUUID(), type: 'text', name: `Chip ${i + 1} label`, x: cx + 18, y: oy + 168, width: 40, height: 16, fill: 'transparent', text: cats[i], fontSize: 13, textColor: active ? '#ffffff' : DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      }
      // 2x2 product grid
      const products = [
        { name: 'T-Shirt', price: '$24', color: '#fbbf24' },
        { name: 'Sneakers', price: '$89', color: '#60a5fa' },
        { name: 'Backpack', price: '$59', color: '#34d399' },
        { name: 'Watch', price: '$129', color: '#f87171' },
      ];
      for (let i = 0; i < 4; i++) {
        const px = ox + 24 + (i % 2) * 168;
        const py = oy + 220 + Math.floor(i / 2) * 220;
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Product card ${i + 1}`, x: px, y: py, width: 156, height: 200, fill: '#ffffff', stroke: GRAY, strokeWidth: 1, radius: 12, fontSize: 14, textColor: DARK });
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Product image ${i + 1}`, x: px + 12, y: py + 12, width: 132, height: 120, fill: products[i].color, stroke: 'transparent', strokeWidth: 0, radius: 8, fontSize: 14, textColor: DARK });
        add({ id: crypto.randomUUID(), type: 'text', name: `Product name ${i + 1}`, x: px + 12, y: py + 144, width: 130, height: 18, fill: 'transparent', text: products[i].name, fontSize: 14, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
        add({ id: crypto.randomUUID(), type: 'text', name: `Product price ${i + 1}`, x: px + 12, y: py + 164, width: 80, height: 18, fill: 'transparent', text: products[i].price, fontSize: 14, textColor: '#0ea5e9', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      }
      // Bottom tab bar
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Tab bar', x: ox, y: oy + 720, width: 375, height: 68, fill: '#ffffff', stroke: GRAY, strokeWidth: 1, radius: 0, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Tab home', x: ox + 40, y: oy + 736, width: 40, height: 24, fill: 'transparent', text: '⌂', fontSize: 22, textColor: '#0ea5e9', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Tab cart', x: ox + 180, y: oy + 736, width: 40, height: 24, fill: 'transparent', text: '🛒', fontSize: 22, textColor: '#94a3b8', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Tab profile', x: ox + 320, y: oy + 736, width: 40, height: 24, fill: 'transparent', text: '☻', fontSize: 22, textColor: '#94a3b8', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      break;
    }
    case 'mobile_product_detail': {
      // Ecommerce step 2: product detail with image, price, description, add-to-cart.
      addFrame(375, 812, 'Mobile / Shop · Product');
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Product image', x: ox, y: oy, width: 375, height: 360, fill: '#fbbf24', stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Back button', x: ox + 16, y: oy + 48, width: 40, height: 32, fill: 'transparent', text: '←', fontSize: 28, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Heart icon', x: ox + 320, y: oy + 48, width: 32, height: 32, fill: 'transparent', text: '♡', fontSize: 28, textColor: '#ef4444', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Product title', x: ox + 24, y: oy + 384, width: 280, height: 28, fill: 'transparent', text: 'Premium T-Shirt', fontSize: 22, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Price', x: ox + 24, y: oy + 420, width: 100, height: 24, fill: 'transparent', text: '$24.00', fontSize: 20, textColor: '#0ea5e9', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Rating', x: ox + 250, y: oy + 424, width: 100, height: 18, fill: 'transparent', text: '★ 4.8 (132)', fontSize: 13, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Section label', x: ox + 24, y: oy + 464, width: 100, height: 18, fill: 'transparent', text: 'Description', fontSize: 14, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Description', x: ox + 24, y: oy + 488, width: 327, height: 60, fill: 'transparent', text: 'Soft cotton blend with a modern fit. Available in multiple colors.', fontSize: 14, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Size selector
      add({ id: crypto.randomUUID(), type: 'text', name: 'Size label', x: ox + 24, y: oy + 568, width: 80, height: 18, fill: 'transparent', text: 'Size:', fontSize: 14, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      const sizes = ['S', 'M', 'L', 'XL'];
      for (let i = 0; i < sizes.length; i++) {
        const sx = ox + 80 + i * 50;
        const active = i === 1;
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Size ${sizes[i]}`, x: sx, y: oy + 560, width: 40, height: 36, fill: active ? '#0ea5e9' : '#ffffff', stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: active ? '#ffffff' : DARK });
        add({ id: crypto.randomUUID(), type: 'text', name: `Size ${sizes[i]} label`, x: sx + 14, y: oy + 570, width: 20, height: 18, fill: 'transparent', text: sizes[i], fontSize: 14, textColor: active ? '#ffffff' : DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      }
      // Add to cart button (sticky bottom)
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Add to cart button', x: ox + 24, y: oy + 700, width: 327, height: 52, fill: '#0ea5e9', stroke: 'transparent', strokeWidth: 0, radius: 12, fontSize: 16, textColor: '#ffffff' });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Add to cart label', x: ox + 110, y: oy + 718, width: 200, height: 20, fill: 'transparent', text: 'Add to cart', fontSize: 16, textColor: '#ffffff', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      break;
    }
    case 'mobile_cart': {
      // Ecommerce step 3: cart with line items + subtotal + checkout button.
      addFrame(375, 812, 'Mobile / Shop · Cart');
      add({ id: crypto.randomUUID(), type: 'text', name: 'Headline', x: ox + 32, y: oy + 56, width: 200, height: 28, fill: 'transparent', text: 'Your cart', fontSize: 24, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // 2 cart items
      const items = [
        { name: 'T-Shirt', color: 'Yellow', size: 'M', price: '$24' },
        { name: 'Sneakers', color: 'Blue', size: '10', price: '$89' },
      ];
      for (let i = 0; i < 2; i++) {
        const iy = oy + 120 + i * 96;
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Cart item ${i + 1}`, x: ox + 24, y: iy, width: 327, height: 80, fill: '#ffffff', stroke: GRAY, strokeWidth: 1, radius: 12, fontSize: 14, textColor: DARK });
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Item ${i + 1} image`, x: ox + 36, y: iy + 12, width: 56, height: 56, fill: i === 0 ? '#fbbf24' : '#60a5fa', stroke: 'transparent', strokeWidth: 0, radius: 8, fontSize: 14, textColor: DARK });
        add({ id: crypto.randomUUID(), type: 'text', name: `Item ${i + 1} name`, x: ox + 104, y: iy + 16, width: 150, height: 18, fill: 'transparent', text: items[i].name, fontSize: 15, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
        add({ id: crypto.randomUUID(), type: 'text', name: `Item ${i + 1} variant`, x: ox + 104, y: iy + 36, width: 150, height: 14, fill: 'transparent', text: `${items[i].color} · Size ${items[i].size}`, fontSize: 12, textColor: '#94a3b8', stroke: 'transparent', strokeWidth: 0, radius: 0 });
        add({ id: crypto.randomUUID(), type: 'text', name: `Item ${i + 1} price`, x: ox + 290, y: iy + 16, width: 60, height: 18, fill: 'transparent', text: items[i].price, fontSize: 15, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
        // Qty stepper
        add({ id: crypto.randomUUID(), type: 'text', name: `Item ${i + 1} qty`, x: ox + 290, y: iy + 44, width: 50, height: 18, fill: 'transparent', text: '− 1 +', fontSize: 13, textColor: '#0ea5e9', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      }
      // Summary
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Summary divider', x: ox + 24, y: oy + 320, width: 327, height: 1, fill: GRAY, stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Subtotal label', x: ox + 24, y: oy + 340, width: 120, height: 18, fill: 'transparent', text: 'Subtotal', fontSize: 14, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Subtotal value', x: ox + 290, y: oy + 340, width: 60, height: 18, fill: 'transparent', text: '$113.00', fontSize: 14, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Shipping label', x: ox + 24, y: oy + 364, width: 120, height: 18, fill: 'transparent', text: 'Shipping', fontSize: 14, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Shipping value', x: ox + 290, y: oy + 364, width: 60, height: 18, fill: 'transparent', text: 'Free', fontSize: 14, textColor: '#10b981', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Total label', x: ox + 24, y: oy + 396, width: 100, height: 22, fill: 'transparent', text: 'Total', fontSize: 16, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Total value', x: ox + 280, y: oy + 396, width: 70, height: 22, fill: 'transparent', text: '$113.00', fontSize: 18, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Checkout button
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Checkout button', x: ox + 24, y: oy + 700, width: 327, height: 52, fill: '#0ea5e9', stroke: 'transparent', strokeWidth: 0, radius: 12, fontSize: 16, textColor: '#ffffff' });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Checkout label', x: ox + 110, y: oy + 718, width: 200, height: 20, fill: 'transparent', text: 'Checkout', fontSize: 16, textColor: '#ffffff', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      break;
    }
    case 'mobile_checkout': {
      // Ecommerce step 4: checkout with payment form + place-order button.
      addFrame(375, 812, 'Mobile / Shop · Checkout');
      add({ id: crypto.randomUUID(), type: 'text', name: 'Headline', x: ox + 32, y: oy + 56, width: 200, height: 28, fill: 'transparent', text: 'Checkout', fontSize: 24, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Order summary card
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Summary card', x: ox + 24, y: oy + 112, width: 327, height: 72, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 12, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Summary label', x: ox + 40, y: oy + 124, width: 200, height: 16, fill: 'transparent', text: '2 items · Total', fontSize: 13, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Summary total', x: ox + 40, y: oy + 144, width: 200, height: 24, fill: 'transparent', text: '$113.00', fontSize: 20, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Payment method section
      add({ id: crypto.randomUUID(), type: 'text', name: 'Section label', x: ox + 24, y: oy + 216, width: 200, height: 18, fill: 'transparent', text: 'Payment method', fontSize: 14, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Card option', x: ox + 24, y: oy + 244, width: 327, height: 56, fill: '#ffffff', stroke: '#0ea5e9', strokeWidth: 2, radius: 12, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Card icon', x: ox + 40, y: oy + 260, width: 32, height: 24, fill: 'transparent', text: '💳', fontSize: 22, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Card label', x: ox + 84, y: oy + 256, width: 200, height: 18, fill: 'transparent', text: '•••• 4242', fontSize: 15, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Card sub', x: ox + 84, y: oy + 276, width: 200, height: 14, fill: 'transparent', text: 'Visa · Expires 12/27', fontSize: 12, textColor: '#94a3b8', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Email field
      add({ id: crypto.randomUUID(), type: 'text', name: 'Email label', x: ox + 24, y: oy + 320, width: 200, height: 14, fill: 'transparent', text: 'Email', fontSize: 12, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Email field', x: ox + 24, y: oy + 340, width: 327, height: 44, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Email placeholder', x: ox + 40, y: oy + 352, width: 200, height: 18, fill: 'transparent', text: 'you@example.com', fontSize: 14, textColor: '#94a3b8', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Shipping address
      add({ id: crypto.randomUUID(), type: 'text', name: 'Address label', x: ox + 24, y: oy + 404, width: 200, height: 14, fill: 'transparent', text: 'Shipping address', fontSize: 12, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Address field', x: ox + 24, y: oy + 424, width: 327, height: 80, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Address placeholder', x: ox + 40, y: oy + 436, width: 280, height: 18, fill: 'transparent', text: '123 Main St', fontSize: 14, textColor: '#94a3b8', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Address placeholder 2', x: ox + 40, y: oy + 460, width: 280, height: 18, fill: 'transparent', text: 'San Francisco, CA 94103', fontSize: 14, textColor: '#94a3b8', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Place order button
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Place order button', x: ox + 24, y: oy + 700, width: 327, height: 52, fill: '#10b981', stroke: 'transparent', strokeWidth: 0, radius: 12, fontSize: 16, textColor: '#ffffff' });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Place order label', x: ox + 100, y: oy + 718, width: 200, height: 20, fill: 'transparent', text: 'Place order', fontSize: 16, textColor: '#ffffff', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      break;
    }
    case 'mobile_dashboard': {
      // Mobile dashboard — best practices (2025) applied:
      //  - 4 stat cards (2x2 grid) with trend indicators (▲▼ +X%)
      //  - Status bar (iOS-style time + battery) at top
      //  - Header with hamburger menu + title + avatar
      //  - Chart placeholder with sketched axes + a line hint
      //  - 3 list items (not 1) showing the repeating pattern
      //  - Bottom tab bar with 4 icons + labels (Home/Search/Activity/Profile)
      //  - Floating Action Button (FAB) for "+ Add" quick action
      //  - Bottom safe-area / home-indicator strip (iOS)
      // All elements fit inside the 375x812 frame (iPhone X+ aspect).
      addFrame(375, 812, 'Mobile / Dashboard');

      // Status bar (iOS-style)
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Status bar', x: ox, y: oy, width: 375, height: 44, fill: '#ffffff', stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Status time', x: ox + 24, y: oy + 16, width: 50, height: 16, fill: 'transparent', text: '9:41', fontSize: 14, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Status battery', x: ox + 320, y: oy + 16, width: 40, height: 16, fill: 'transparent', text: '100%', fontSize: 13, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });

      // Header (hamburger + title + avatar)
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Header', x: ox, y: oy + 44, width: 375, height: 56, fill: '#ffffff', stroke: GRAY, strokeWidth: 1, radius: 0, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Menu icon', x: ox + 16, y: oy + 62, width: 24, height: 24, fill: 'transparent', text: '☰', fontSize: 22, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Header title', x: ox + 140, y: oy + 60, width: 100, height: 24, fill: 'transparent', text: 'Dashboard', fontSize: 18, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'ellipse', name: 'Header avatar', x: ox + 335, y: oy + 56, width: 32, height: 32, fill: GRAY, stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });

      // 4 stat cards (2x2 grid) with values + labels + trend indicators
      // Row 1 (y = 120): Revenue, Users
      // Row 2 (y = 220): Orders, Conversion
      const statData = [
        { label: 'Revenue', value: '$12,430', trend: '↑ 12%', trendColor: '#10b981', x: 16 },
        { label: 'Users', value: '1,284', trend: '↑ 8%', trendColor: '#10b981', x: 194 },
        { label: 'Orders', value: '342', trend: '↓ 3%', trendColor: '#ef4444', x: 16 },
        { label: 'Conv. rate', value: '4.2%', trend: '↑ 1.2%', trendColor: '#10b981', x: 194 },
      ];
      for (let i = 0; i < 4; i++) {
        const s = statData[i];
        const sy = oy + 120 + (i >= 2 ? 100 : 0);
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Stat card ${i + 1}`, x: ox + s.x, y: sy, width: 165, height: 88, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 12, fontSize: 14, textColor: DARK });
        add({ id: crypto.randomUUID(), type: 'text', name: `Stat ${i + 1} label`, x: ox + s.x + 14, y: sy + 12, width: 120, height: 14, fill: 'transparent', text: s.label, fontSize: 11, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
        add({ id: crypto.randomUUID(), type: 'text', name: `Stat ${i + 1} value`, x: ox + s.x + 14, y: sy + 30, width: 130, height: 28, fill: 'transparent', text: s.value, fontSize: 22, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
        add({ id: crypto.randomUUID(), type: 'text', name: `Stat ${i + 1} trend`, x: ox + s.x + 14, y: sy + 62, width: 80, height: 16, fill: 'transparent', text: s.trend, fontSize: 12, textColor: s.trendColor, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      }

      // Chart placeholder with sketched axes + line hint
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Chart card', x: ox + 16, y: oy + 320, width: 343, height: 180, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 12, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Chart title', x: ox + 32, y: oy + 336, width: 200, height: 16, fill: 'transparent', text: 'Revenue (last 30 days)', fontSize: 13, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Y-axis labels
      add({ id: crypto.randomUUID(), type: 'text', name: 'Y-axis top', x: ox + 24, y: oy + 376, width: 24, height: 12, fill: 'transparent', text: '$15k', fontSize: 9, textColor: '#94a3b8', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Y-axis mid', x: ox + 24, y: oy + 424, width: 24, height: 12, fill: 'transparent', text: '$7k', fontSize: 9, textColor: '#94a3b8', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Y-axis bot', x: ox + 24, y: oy + 472, width: 24, height: 12, fill: 'transparent', text: '$0', fontSize: 9, textColor: '#94a3b8', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Sketched line chart (polyline hint) — 7 data points
      const linePts = [60, 45, 55, 30, 40, 25, 15];
      for (let i = 0; i < linePts.length - 1; i++) {
        const x1 = ox + 60 + i * 40;
        const y1 = oy + 480 - linePts[i];
        const x2 = ox + 60 + (i + 1) * 40;
        const y2 = oy + 480 - linePts[i + 1];
        add({ id: crypto.randomUUID(), type: 'line', name: `Chart line ${i + 1}`, x: x1, y: y1, width: Math.abs(x2 - x1) + 2, height: Math.abs(y2 - y1) + 2, fill: 'transparent', stroke: '#0ea5e9', strokeWidth: 2, radius: 0, fontSize: 14, textColor: DARK });
      }
      // X-axis labels (days)
      const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      for (let i = 0; i < days.length; i++) {
        add({ id: crypto.randomUUID(), type: 'text', name: `X-axis ${i + 1}`, x: ox + 52 + i * 40, y: oy + 488, width: 30, height: 10, fill: 'transparent', text: days[i], fontSize: 9, textColor: '#94a3b8', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      }

      // Section header for activity list
      add({ id: crypto.randomUUID(), type: 'text', name: 'Activity label', x: ox + 16, y: oy + 520, width: 200, height: 18, fill: 'transparent', text: 'Recent activity', fontSize: 15, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'See all link', x: ox + 300, y: oy + 520, width: 60, height: 18, fill: 'transparent', text: 'See all', fontSize: 13, textColor: '#0ea5e9', stroke: 'transparent', strokeWidth: 0, radius: 0 });

      // 3 list items (was 1 — repeating pattern is critical for component reuse)
      const listItems = [
        { name: 'Sarah Chen', sub: 'Pro · 2 min ago', amount: '+$240' },
        { name: 'Alex Park', sub: 'Team · 18 min ago', amount: '+$1.2k' },
        { name: 'Maya Lee', sub: 'Free · 1 hr ago', amount: '+$89' },
      ];
      for (let i = 0; i < 3; i++) {
        const ly = oy + 552 + i * 64;
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `List item ${i + 1}`, x: ox + 16, y: ly, width: 343, height: 56, fill: '#ffffff', stroke: GRAY, strokeWidth: 1, radius: 12, fontSize: 14, textColor: DARK });
        add({ id: crypto.randomUUID(), type: 'ellipse', name: `Avatar ${i + 1}`, x: ox + 28, y: ly + 12, width: 32, height: 32, fill: GRAY, stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
        add({ id: crypto.randomUUID(), type: 'text', name: `Item ${i + 1} title`, x: ox + 72, y: ly + 14, width: 180, height: 16, fill: 'transparent', text: listItems[i].name, fontSize: 14, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
        add({ id: crypto.randomUUID(), type: 'text', name: `Item ${i + 1} sub`, x: ox + 72, y: ly + 32, width: 180, height: 14, fill: 'transparent', text: listItems[i].sub, fontSize: 12, textColor: '#94a3b8', stroke: 'transparent', strokeWidth: 0, radius: 0 });
        add({ id: crypto.randomUUID(), type: 'text', name: `Item ${i + 1} amount`, x: ox + 290, y: ly + 18, width: 60, height: 16, fill: 'transparent', text: listItems[i].amount, fontSize: 13, textColor: '#10b981', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      }

      // Bottom tab bar with 4 tabs (icon + label each)
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Tab bar', x: ox, y: oy + 720, width: 375, height: 68, fill: '#ffffff', stroke: GRAY, strokeWidth: 1, radius: 0, fontSize: 14, textColor: DARK });
      const tabs = [
        { icon: '⌂', label: 'Home', active: true },
        { icon: '⌕', label: 'Search', active: false },
        { icon: '◔', label: 'Activity', active: false },
        { icon: '☻', label: 'Profile', active: false },
      ];
      for (let i = 0; i < tabs.length; i++) {
        const tx = ox + 24 + i * 90;
        const tColor = tabs[i].active ? '#0ea5e9' : '#94a3b8';
        add({ id: crypto.randomUUID(), type: 'text', name: `Tab ${i + 1} icon`, x: tx, y: oy + 736, width: 40, height: 24, fill: 'transparent', text: tabs[i].icon, fontSize: 22, textColor: tColor, stroke: 'transparent', strokeWidth: 0, radius: 0 });
        add({ id: crypto.randomUUID(), type: 'text', name: `Tab ${i + 1} label`, x: tx, y: oy + 762, width: 60, height: 14, fill: 'transparent', text: tabs[i].label, fontSize: 10, textColor: tColor, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      }

      // Floating Action Button (FAB) — best practice for mobile dashboards
      add({ id: crypto.randomUUID(), type: 'ellipse', name: 'FAB', x: ox + 304, y: oy + 670, width: 56, height: 56, fill: '#0ea5e9', stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: '#ffffff' });
      add({ id: crypto.randomUUID(), type: 'text', name: 'FAB icon', x: ox + 320, y: oy + 684, width: 24, height: 28, fill: 'transparent', text: '+', fontSize: 28, textColor: '#ffffff', stroke: 'transparent', strokeWidth: 0, radius: 0 });

      // Home indicator (iOS bottom safe area)
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Home indicator', x: ox + 134, y: oy + 784, width: 107, height: 4, fill: DARK, stroke: 'transparent', strokeWidth: 0, radius: 2, fontSize: 14, textColor: DARK });
      break;
    }
    case 'web_landing': {
      addFrame(1280, 800, 'Web / Landing');
      // Nav
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Nav', x: ox, y: oy, width: 1280, height: 64, fill: '#ffffff', stroke: GRAY, strokeWidth: 1, radius: 0, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Logo', x: ox + 48, y: oy + 22, width: 100, height: 20, fill: 'transparent', text: 'Brand', fontSize: 18, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Nav CTA', x: ox + 1130, y: oy + 14, width: 100, height: 36, fill: DARK, stroke: 'transparent', strokeWidth: 0, radius: 6, fontSize: 14, textColor: '#ffffff' });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Nav CTA label', x: ox + 1152, y: oy + 24, width: 60, height: 16, fill: 'transparent', text: 'Sign up', fontSize: 13, textColor: '#ffffff', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Hero
      add({ id: crypto.randomUUID(), type: 'text', name: 'Hero heading', x: ox + 48, y: oy + 200, width: 600, height: 64, fill: 'transparent', text: 'Build better, ship faster', fontSize: 48, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Hero subheading', x: ox + 48, y: oy + 280, width: 560, height: 48, fill: 'transparent', text: 'The platform that turns ideas into products. Trusted by 10,000+ teams.', fontSize: 18, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Primary CTA', x: ox + 48, y: oy + 360, width: 160, height: 48, fill: DARK, stroke: 'transparent', strokeWidth: 0, radius: 8, fontSize: 14, textColor: '#ffffff' });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Primary CTA label', x: ox + 80, y: oy + 376, width: 100, height: 16, fill: 'transparent', text: 'Get started', fontSize: 14, textColor: '#ffffff', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Secondary CTA', x: ox + 224, y: oy + 360, width: 140, height: 48, fill: 'transparent', stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Secondary CTA label', x: ox + 250, y: oy + 376, width: 90, height: 16, fill: 'transparent', text: 'Watch demo', fontSize: 14, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Hero image placeholder
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Hero image', x: ox + 720, y: oy + 160, width: 480, height: 320, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 12, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'ellipse', name: 'Image icon', x: ox + 936, y: oy + 296, width: 48, height: 48, fill: GRAY, stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      // Logos strip
      add({ id: crypto.randomUUID(), type: 'text', name: 'Logos label', x: ox + 48, y: oy + 560, width: 200, height: 16, fill: 'transparent', text: 'Trusted by', fontSize: 13, textColor: '#94a3b8', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      for (let i = 0; i < 5; i++) {
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Logo ${i + 1}`, x: ox + 48 + i * 200, y: oy + 600, width: 160, height: 32, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 4, fontSize: 14, textColor: DARK });
      }
      break;
    }
    case 'web_dashboard': {
      // Task 8-a — dense, fintech-grade dashboard (VLM 3.5/10 critique, fix #1:
      // "critically sparse"). The old 39-shape scaffold showed 2 cards; this one
      // emits a full information architecture on a strict spacing grid:
      //   - 40px page padding + 24px gutters; every card shares the same left
      //     edge and full content width (fix #3: alignment / spacing grid).
      //   - LIGHT sidebar with icon+label nav items, section groups, and a
      //     user block (fix #5: sidebar usability — was a heavy dark slab).
      //   - 4-KPI row: label + big value + delta badge + sparkline per card.
      //   - Revenue-over-time AREA chart: gridlines, y/x axis labels, a
      //     previous-year comparison line, and a date-range chip.
      //   - Recent Transactions table: 4 columns × 5 rows + row dividers,
      //     amounts right-aligned, status color-coded.
      // Card polish (radius 12 + 1px border + subtle shadow) comes from
      // applyHighFidelityStyling; typography from applyTypographyByName — the
      // shape names below deliberately match those buckets ("Stat 1 value",
      // "Table header 1", "Transaction 1 description", …) so styling auto-applies.
      addFrame(1280, 800, 'Web / Dashboard');
      // Spacing grid (VLM fix #3 — bake the grid into the math, don't eyeball it).
      const PAD = 40;                    // page padding
      const GUTTER = 24;                 // gutters between cards
      const CARD_R = 12;                 // card corner radius (VLM fix #2)
      const CX = 240 + PAD;              // content left edge (280) — every card starts here
      const CW = 1280 - 240 - PAD * 2;   // content width (960) — every card spans this
      // Semantic accent ramps for delta badges / status text.
      const SUCCESS_TINT = '#ecfdf5';    // emerald-50
      const SUCCESS_TEXT = '#059669';    // emerald-600
      const DANGER_TINT = '#fef2f2';     // rose-50
      const DANGER_TEXT = '#e11d48';     // rose-600
      const WARNING_TEXT = '#b45309';    // amber-700
      const SIDEBAR_BG = '#f8fafc';      // slate-50 — LIGHT sidebar (VLM fix #5)
      const ACTIVE_TINT = '#e0f2fe';     // sky-100 active nav pill
      const ACTIVE_TEXT = '#0369a1';     // sky-700 active nav text

      // ---- Sidebar (light, grouped icon+label nav, user block) --------------
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Sidebar', x: ox, y: oy, width: 240, height: 800, fill: SIDEBAR_BG, stroke: GRAY, strokeWidth: 1, radius: 0, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Logo mark', x: ox + 24, y: oy + 20, width: 28, height: 28, fill: PRIMARY, stroke: 'transparent', strokeWidth: 0, radius: 8, fontSize: 14, textColor: '#ffffff' });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Sidebar logo', x: ox + 62, y: oy + 25, width: 130, height: 20, fill: 'transparent', text: 'Acme', fontSize: 17, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Sidebar section label 1', x: ox + 24, y: oy + 76, width: 120, height: 14, fill: 'transparent', text: 'MENU', fontSize: 11, textColor: TEXT_SUBTLE, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Group 1 — primary navigation (icon glyph + label, active pill on item 1).
      const NAV = [
        { icon: '◆', label: 'Dashboard', active: true },
        { icon: '●', label: 'Transactions', active: false },
        { icon: '▲', label: 'Payments', active: false },
        { icon: '■', label: 'Accounts', active: false },
        { icon: '○', label: 'Reports', active: false },
        { icon: '◇', label: 'Settings', active: false },
      ];
      for (let i = 0; i < NAV.length; i++) {
        const ny = oy + 98 + i * 44;
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Nav item ${i + 1}`, x: ox + 16, y: ny, width: 208, height: 36, fill: NAV[i].active ? ACTIVE_TINT : 'transparent', stroke: 'transparent', strokeWidth: 0, radius: 8, fontSize: 13, textColor: NAV[i].active ? ACTIVE_TEXT : TEXT_MUTED });
        add({ id: crypto.randomUUID(), type: 'text', name: `Nav item ${i + 1} icon`, x: ox + 30, y: ny + 10, width: 20, height: 18, fill: 'transparent', text: NAV[i].icon, fontSize: 13, textColor: NAV[i].active ? ACTIVE_TEXT : TEXT_SUBTLE, stroke: 'transparent', strokeWidth: 0, radius: 0 });
        add({ id: crypto.randomUUID(), type: 'text', name: `Nav item ${i + 1} label`, x: ox + 58, y: ny + 10, width: 150, height: 16, fill: 'transparent', text: NAV[i].label, fontSize: 13, textColor: NAV[i].active ? ACTIVE_TEXT : TEXT_MUTED, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      }
      // Group 2 — secondary section (VLM fix #5: "section groups").
      add({ id: crypto.randomUUID(), type: 'text', name: 'Sidebar section label 2', x: ox + 24, y: oy + 372, width: 120, height: 14, fill: 'transparent', text: 'GENERAL', fontSize: 11, textColor: TEXT_SUBTLE, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      const NAV2 = [
        { icon: '?', label: 'Help center' },
        { icon: '→', label: 'Log out' },
      ];
      for (let i = 0; i < NAV2.length; i++) {
        const ny = oy + 396 + i * 44;
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Nav item ${NAV.length + i + 1}`, x: ox + 16, y: ny, width: 208, height: 36, fill: 'transparent', stroke: 'transparent', strokeWidth: 0, radius: 8, fontSize: 13, textColor: TEXT_MUTED });
        add({ id: crypto.randomUUID(), type: 'text', name: `Nav item ${NAV.length + i + 1} icon`, x: ox + 30, y: ny + 10, width: 20, height: 18, fill: 'transparent', text: NAV2[i].icon, fontSize: 13, textColor: TEXT_SUBTLE, stroke: 'transparent', strokeWidth: 0, radius: 0 });
        add({ id: crypto.randomUUID(), type: 'text', name: `Nav item ${NAV.length + i + 1} label`, x: ox + 58, y: ny + 10, width: 150, height: 16, fill: 'transparent', text: NAV2[i].label, fontSize: 13, textColor: TEXT_MUTED, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      }
      // User block pinned to the sidebar bottom.
      add({ id: crypto.randomUUID(), type: 'ellipse', name: 'Sidebar user avatar', x: ox + 24, y: oy + 724, width: 32, height: 32, fill: '#c7d2fe', stroke: GRAY, strokeWidth: 1, radius: 0, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Sidebar user name', x: ox + 66, y: oy + 726, width: 150, height: 16, fill: 'transparent', text: 'Sarah Chen', fontSize: 13, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Sidebar user email', x: ox + 66, y: oy + 744, width: 150, height: 14, fill: 'transparent', text: 'sarah@acme.com', fontSize: 11, textColor: TEXT_SUBTLE, stroke: 'transparent', strokeWidth: 0, radius: 0 });

      // ---- Topbar (title + search + notification + avatar) -----------------
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Topbar', x: ox + 240, y: oy, width: 1040, height: 64, fill: '#ffffff', stroke: GRAY, strokeWidth: 1, radius: 0, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Page title', x: ox + CX, y: oy + 19, width: 300, height: 26, fill: 'transparent', text: 'Overview', fontSize: 20, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Search field', x: ox + 920, y: oy + 14, width: 200, height: 36, fill: '#f8fafc', stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 13, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Search placeholder', x: ox + 936, y: oy + 23, width: 170, height: 16, fill: 'transparent', text: 'Search transactions…', fontSize: 13, textColor: TEXT_SUBTLE, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'ellipse', name: 'Topbar avatar', x: ox + 1200, y: oy + 14, width: 36, height: 36, fill: '#c7d2fe', stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'ellipse', name: 'Notification dot', x: ox + 1227, y: oy + 15, width: 8, height: 8, fill: DANGER, stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });

      // ---- KPI row (VLM fix #1 — 4 stat cards, 24px gutters) ----------------
      // Each card: UPPERCASE label / 36px value / delta pill / sparkline path.
      const KPIS = [
        { label: 'TOTAL REVENUE', value: '$128.4K', delta: '▲ +12.5%', good: true },
        { label: 'TOTAL EXPENSES', value: '$42.1K', delta: '▲ +4.2%', good: false },
        { label: 'ACTIVE USERS', value: '8,249', delta: '▲ +8.1%', good: true },
        { label: 'GROWTH RATE', value: '+18.9%', delta: '▲ +2.4 pts', good: true },
      ];
      const KPI_W = (CW - GUTTER * 3) / 4;   // 222
      const KPI_Y = 64 + PAD;                // 104 — topbar + page padding
      const KPI_H = 132;                     // Task 8-c: +4px for 24px card padding (VLM 8px-grid fix)
      // Task 8-c — page background (#F9FAFB) so white cards read as elevated
      // surfaces instead of blending into the page (VLM fix: "cards blend into bg").
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Page background', x: ox + 240, y: oy + 64, width: 1040, height: 736, fill: '#F9FAFB', stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      // Sparkline wiggle patterns (varied per card so they don't look cloned).
      const SPARKS = [
        [0.5, 0.3, 0.6, 0.35, 0.7, 0.8],
        [0.6, 0.65, 0.4, 0.55, 0.3, 0.5],
        [0.3, 0.5, 0.4, 0.65, 0.5, 0.75],
        [0.45, 0.3, 0.55, 0.5, 0.65, 0.55],
      ];
      for (let i = 0; i < KPIS.length; i++) {
        const kx = ox + CX + i * (KPI_W + GUTTER);
        const ky = oy + KPI_Y;
        // Task 8-c — hero emphasis (VLM fix #1: "revenue should be 1.5-2x larger
        // than the other metrics"): card 1 value 40px, cards 2-4 values 26px.
        const heroVal = i === 0;
        const valSize = heroVal ? 40 : 26;
        const valH = heroVal ? 44 : 30;
        // Task 8-c — semantic badge tint: amber for the EXPENSES card (VLM fix:
        // "change expense badge to amber"), emerald for good, rose only for bad.
        const badgeTint = i === 1 ? '#fffbeb' : KPIS[i].good ? SUCCESS_TINT : DANGER_TINT;
        const badgeText = i === 1 ? WARNING_TEXT : KPIS[i].good ? SUCCESS_TEXT : DANGER_TEXT;
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Stat card ${i + 1}`, x: kx, y: ky, width: KPI_W, height: KPI_H, fill: SURFACE, stroke: GRAY, strokeWidth: 1, radius: CARD_R, fontSize: 14, textColor: DARK });
        add({ id: crypto.randomUUID(), type: 'text', name: `Stat ${i + 1} label`, x: kx + 20, y: ky + 20, width: KPI_W - 40, height: 14, fill: 'transparent', text: KPIS[i].label, fontSize: 12, textColor: TEXT_MUTED, stroke: 'transparent', strokeWidth: 0, radius: 0 });
        add({ id: crypto.randomUUID(), type: 'text', name: `Stat ${i + 1} value`, x: kx + 20, y: ky + 42, width: KPI_W - 40, height: valH, fill: 'transparent', text: KPIS[i].value, fontSize: valSize, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Stat ${i + 1} delta badge`, x: kx + 20, y: ky + 88, width: 96, height: 22, fill: badgeTint, stroke: 'transparent', strokeWidth: 0, radius: 9999, fontSize: 11, textColor: badgeText });
        add({ id: crypto.randomUUID(), type: 'text', name: `Stat ${i + 1} delta label`, x: kx + 28, y: ky + 93, width: 84, height: 13, fill: 'transparent', text: KPIS[i].delta, fontSize: 11, textColor: badgeText, stroke: 'transparent', strokeWidth: 0, radius: 0 });
        // Sparkline — 6-point polyline along the card bottom.
        const sparkPts = SPARKS[i].map((p, j) => ({
          x: kx + 20 + j * ((KPI_W - 40) / (SPARKS[i].length - 1)),
          y: ky + 128 - p * 14,
        }));
        add({ id: crypto.randomUUID(), type: 'path', name: `Stat ${i + 1} sparkline`, x: kx + 20, y: ky + 112, width: KPI_W - 40, height: 14, fill: 'transparent', stroke: i === 1 ? WARNING_TEXT : KPIS[i].good ? SUCCESS : DANGER, strokeWidth: 2, radius: 0, fontSize: 14, textColor: DARK, points: sparkPts, closed: false });
      }

      // ---- Revenue-over-time area chart panel -------------------------------
      const CH_Y = KPI_Y + KPI_H + GUTTER;  // 260 (Task 8-c: KPI_H 128→132)
      const CH_H = 240;                     // ends 500 (Task 8-c: trimmed to fit the taller KPI row)
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Revenue chart card', x: ox + CX, y: oy + CH_Y, width: CW, height: CH_H, fill: SURFACE, stroke: GRAY, strokeWidth: 1, radius: CARD_R, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Chart title', x: ox + CX + 24, y: oy + CH_Y + 20, width: 320, height: 20, fill: 'transparent', text: 'Revenue over time', fontSize: 16, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Chart subtitle', x: ox + CX + 24, y: oy + CH_Y + 42, width: 320, height: 14, fill: 'transparent', text: 'Monthly recurring revenue · last 8 months', fontSize: 12, textColor: TEXT_SUBTLE, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Date-range chip (top-right of the panel).
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Chart range chip', x: ox + CX + CW - 24 - 140, y: oy + CH_Y + 18, width: 140, height: 28, fill: '#f8fafc', stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 12, textColor: TEXT_MUTED });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Chart range label', x: ox + CX + CW - 24 - 124, y: oy + CH_Y + 26, width: 110, height: 14, fill: 'transparent', text: 'Last 8 months', fontSize: 12, textColor: TEXT_MUTED, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Plot area geometry.
      const PX0 = CX + 64;                     // y-axis labels live in the 64px gutter
      const PX1 = CX + CW - 24;
      const PW = PX1 - PX0;                    // 872
      const PY0 = CH_Y + 84;
      const PY1 = CH_Y + CH_H - 48;            // 216 — x-axis labels below
      const PH = PY1 - PY0;                    // 132
      // Gridlines + baseline.
      for (let g = 0; g < 3; g++) {
        const gy = PY0 + (PH / 2) * g;
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Chart gridline ${g + 1}`, x: ox + PX0, y: oy + gy, width: PW, height: 1, fill: LIGHT, stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      }
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Chart baseline', x: ox + PX0, y: oy + PY1, width: PW, height: 1, fill: GRAY, stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      // Y-axis labels.
      const Y_LABELS = ['$150K', '$75K', '$0'];
      for (let g = 0; g < 3; g++) {
        const gy = PY0 + (PH / 2) * g;
        add({ id: crypto.randomUUID(), type: 'text', name: `Chart y-axis label ${g + 1}`, x: ox + CX + 24, y: oy + gy - 6, width: 36, height: 14, fill: 'transparent', text: Y_LABELS[g], fontSize: 11, textColor: TEXT_SUBTLE, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      }
      // X-axis labels (8 months) + data with a story: dip in Feb, spike in Mar.
      const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'];
      const REV = [0.42, 0.30, 0.74, 0.58, 0.66, 0.54, 0.82, 0.92];
      const PREV = [0.34, 0.31, 0.42, 0.47, 0.52, 0.50, 0.58, 0.64];
      const slotW = PW / MONTHS.length;
      const mx = (i: number) => PX0 + slotW * i + slotW / 2;
      for (let i = 0; i < MONTHS.length; i++) {
        add({ id: crypto.randomUUID(), type: 'text', name: `Chart month label ${i + 1}`, x: ox + mx(i) - 20, y: oy + PY1 + 10, width: 40, height: 14, fill: 'transparent', text: MONTHS[i], fontSize: 11, textColor: TEXT_SUBTLE, stroke: 'transparent', strokeWidth: 0, radius: 0, textAlign: 'center' });
      }
      // Area fill (closed polygon under the revenue line, translucent emerald).
      const areaPts = [
        { x: ox + PX0, y: oy + PY1 },
        ...REV.map((f, i) => ({ x: ox + mx(i), y: oy + PY1 - f * PH })),
        { x: ox + PX1, y: oy + PY1 },
      ];
      add({ id: crypto.randomUUID(), type: 'path', name: 'Chart area', x: ox + PX0, y: oy + PY0, width: PW, height: PH, fill: SUCCESS, stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK, opacity: 0.1, points: areaPts, closed: true });
      // Revenue trend line.
      add({ id: crypto.randomUUID(), type: 'path', name: 'Chart trend line', x: ox + PX0, y: oy + PY0, width: PW, height: PH, fill: 'transparent', stroke: SUCCESS, strokeWidth: 2.5, radius: 0, fontSize: 14, textColor: DARK, points: REV.map((f, i) => ({ x: ox + mx(i), y: oy + PY1 - f * PH })), closed: false });
      // Task 8-c — data point dots on the trend line (VLM fix #4: "add data
      // point dots") — 6px circles, white stroke so they pop off the line.
      for (let i = 0; i < REV.length; i++) {
        add({ id: crypto.randomUUID(), type: 'ellipse', name: `Chart data point ${i + 1}`, x: ox + mx(i) - 3, y: oy + PY1 - REV[i] * PH - 3, width: 6, height: 6, fill: SUCCESS, stroke: '#ffffff', strokeWidth: 1.5, radius: 0, fontSize: 14, textColor: DARK });
      }
      // Previous-year comparison line (subtle gray).
      add({ id: crypto.randomUUID(), type: 'path', name: 'Chart comparison line', x: ox + PX0, y: oy + PY0, width: PW, height: PH, fill: 'transparent', stroke: TEXT_SUBTLE, strokeWidth: 2, radius: 0, fontSize: 14, textColor: DARK, opacity: 0.7, points: PREV.map((f, i) => ({ x: ox + mx(i), y: oy + PY1 - f * PH })), closed: false });

      // ---- Recent Transactions table (VLM fix #1 — 5 rows) ------------------
      const TB_Y = CH_Y + CH_H + GUTTER;   // 524 (Task 8-c vertical re-budget)
      const TB_H = 800 - PAD - TB_Y;       // 236 — 40px bottom page padding
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Transactions card', x: ox + CX, y: oy + TB_Y, width: CW, height: TB_H, fill: SURFACE, stroke: GRAY, strokeWidth: 1, radius: CARD_R, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Panel title', x: ox + CX + 24, y: oy + TB_Y + 18, width: 320, height: 20, fill: 'transparent', text: 'Recent Transactions', fontSize: 16, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Export button', x: ox + CX + CW - 24 - 110, y: oy + TB_Y + 14, width: 110, height: 28, fill: SURFACE, stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 12, textColor: TEXT_MUTED });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Export button label', x: ox + CX + CW - 24 - 110, y: oy + TB_Y + 21, width: 110, height: 14, fill: 'transparent', text: 'Export CSV', fontSize: 12, textColor: TEXT_MUTED, stroke: 'transparent', strokeWidth: 0, radius: 0, textAlign: 'center' });
      // Column headers — UPPERCASE, 11px/600/+0.5 via the typography bucket.
      const COL_DESC = CX + 24;
      const COL_DATE = CX + 520;
      const COL_STATUS = CX + 660;
      const COL_AMT = CX + CW - 24 - 100;
      add({ id: crypto.randomUUID(), type: 'text', name: 'Table header 1', x: ox + COL_DESC, y: oy + TB_Y + 58, width: 300, height: 14, fill: 'transparent', text: 'DESCRIPTION', fontSize: 11, textColor: TEXT_SUBTLE, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Table header 2', x: ox + COL_DATE, y: oy + TB_Y + 58, width: 120, height: 14, fill: 'transparent', text: 'DATE', fontSize: 11, textColor: TEXT_SUBTLE, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Table header 3', x: ox + COL_STATUS, y: oy + TB_Y + 58, width: 100, height: 14, fill: 'transparent', text: 'STATUS', fontSize: 11, textColor: TEXT_SUBTLE, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Table header 4', x: ox + COL_AMT, y: oy + TB_Y + 58, width: 100, height: 14, fill: 'transparent', text: 'AMOUNT', fontSize: 11, textColor: TEXT_SUBTLE, stroke: 'transparent', strokeWidth: 0, radius: 0, textAlign: 'right' });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Table header divider', x: ox + CX + 24, y: oy + TB_Y + 78, width: CW - 48, height: 1, fill: GRAY, stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      // 5 data rows — real fintech copy, amounts right-aligned + signed,
      // status color-coded (Completed = emerald, Pending = amber).
      const TXNS = [
        { desc: 'Stripe payout · INV-2841', date: 'Aug 24, 2026', status: 'Completed', amount: '+$4,200.00', good: true },
        { desc: 'Payroll · Gusto', date: 'Aug 23, 2026', status: 'Completed', amount: '-$18,750.00', good: false },
        { desc: 'Wire · Acme Corp contract', date: 'Aug 21, 2026', status: 'Pending', amount: '+$12,940.00', good: true },
        { desc: 'AWS infrastructure', date: 'Aug 20, 2026', status: 'Completed', amount: '-$2,104.50', good: false },
        { desc: 'AdSense revenue', date: 'Aug 18, 2026', status: 'Completed', amount: '+$860.25', good: true },
      ];
      for (let r = 0; r < TXNS.length; r++) {
        const ry = oy + TB_Y + 92 + r * 26;
        add({ id: crypto.randomUUID(), type: 'text', name: `Transaction ${r + 1} description`, x: ox + COL_DESC, y: ry, width: 420, height: 18, fill: 'transparent', text: TXNS[r].desc, fontSize: 14, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
        add({ id: crypto.randomUUID(), type: 'text', name: `Transaction ${r + 1} date`, x: ox + COL_DATE, y: ry + 1, width: 120, height: 16, fill: 'transparent', text: TXNS[r].date, fontSize: 13, textColor: TEXT_MUTED, stroke: 'transparent', strokeWidth: 0, radius: 0 });
        add({ id: crypto.randomUUID(), type: 'text', name: `Transaction ${r + 1} status`, x: ox + COL_STATUS, y: ry + 1, width: 100, height: 16, fill: 'transparent', text: TXNS[r].status, fontSize: 13, textColor: TXNS[r].status === 'Pending' ? WARNING_TEXT : SUCCESS_TEXT, stroke: 'transparent', strokeWidth: 0, radius: 0 });
        add({ id: crypto.randomUUID(), type: 'text', name: `Transaction ${r + 1} amount`, x: ox + COL_AMT, y: ry, width: 100, height: 18, fill: 'transparent', text: TXNS[r].amount, fontSize: 14, textColor: TXNS[r].good ? SUCCESS_TEXT : DANGER_TEXT, stroke: 'transparent', strokeWidth: 0, radius: 0, textAlign: 'right' });
        if (r < TXNS.length - 1) {
          add({ id: crypto.randomUUID(), type: 'rectangle', name: `Table row divider ${r + 1}`, x: ox + CX + 24, y: ry + 21, width: CW - 48, height: 1, fill: LIGHT, stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
        }
      }
      break;
    }
    case 'web_blog': {
      addFrame(1280, 800, 'Web / Blog');
      // Header
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Header', x: ox, y: oy, width: 1280, height: 80, fill: '#ffffff', stroke: GRAY, strokeWidth: 1, radius: 0, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Brand', x: ox + 80, y: oy + 28, width: 120, height: 24, fill: 'transparent', text: 'Blog', fontSize: 22, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Hero post
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Hero image', x: ox + 80, y: oy + 120, width: 640, height: 360, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 12, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Hero title', x: ox + 760, y: oy + 140, width: 440, height: 56, fill: 'transparent', text: 'Designing for the AI era', fontSize: 32, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Hero excerpt', x: ox + 760, y: oy + 220, width: 440, height: 120, fill: 'transparent', text: 'How AI is reshaping the design workflow, from research to delivery, and what it means for product teams in 2026.', fontSize: 15, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'ellipse', name: 'Author avatar', x: ox + 760, y: oy + 360, width: 40, height: 40, fill: GRAY, stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Author name', x: ox + 812, y: oy + 364, width: 200, height: 16, fill: 'transparent', text: 'Sarah Chen · 6 min read', fontSize: 13, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Post grid
      for (let i = 0; i < 3; i++) {
        const px = ox + 80 + i * 386;
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Post ${i + 1} image`, x: px, y: oy + 540, width: 360, height: 180, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: DARK });
        add({ id: crypto.randomUUID(), type: 'text', name: `Post ${i + 1} title`, x: px, y: oy + 740, width: 360, height: 24, fill: 'transparent', text: ['AI design tools', 'Design systems', 'Prototyping'][i], fontSize: 16, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      }
      break;
    }
    case 'web_pricing': {
      addFrame(1280, 800, 'Web / Pricing');
      add({ id: crypto.randomUUID(), type: 'text', name: 'Page heading', x: ox + 440, y: oy + 80, width: 400, height: 48, fill: 'transparent', text: 'Simple, transparent pricing', fontSize: 36, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Page subheading', x: ox + 380, y: oy + 140, width: 520, height: 24, fill: 'transparent', text: 'Start free. Upgrade when you grow.', fontSize: 16, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      for (let i = 0; i < 3; i++) {
        const px = ox + 240 + i * 320;
        const featured = i === 1;
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Tier ${i + 1} card`, x: px, y: oy + 220, width: 280, height: 440, fill: '#ffffff', stroke: featured ? DARK : GRAY, strokeWidth: featured ? 2 : 1, radius: 12, fontSize: 14, textColor: DARK });
        add({ id: crypto.randomUUID(), type: 'text', name: `Tier ${i + 1} name`, x: px + 24, y: oy + 248, width: 200, height: 20, fill: 'transparent', text: ['Starter', 'Pro', 'Enterprise'][i], fontSize: 18, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
        add({ id: crypto.randomUUID(), type: 'text', name: `Tier ${i + 1} price`, x: px + 24, y: oy + 288, width: 200, height: 40, fill: 'transparent', text: ['$0', '$24', 'Custom'][i], fontSize: 36, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Tier ${i + 1} CTA`, x: px + 24, y: oy + 360, width: 232, height: 40, fill: featured ? DARK : LIGHT, stroke: 'transparent', strokeWidth: 0, radius: 8, fontSize: 14, textColor: featured ? '#ffffff' : DARK });
        for (let j = 0; j < 4; j++) {
          add({ id: crypto.randomUUID(), type: 'rectangle', name: `Tier ${i + 1} feature ${j + 1}`, x: px + 24, y: oy + 420 + j * 28, width: 200, height: 8, fill: LIGHT, stroke: 'transparent', strokeWidth: 0, radius: 4, fontSize: 14, textColor: DARK });
        }
      }
      break;
    }
    default: {
      // Fallback: empty frame.
      addFrame(400, 300, 'Wireframe');
      break;
    }
  }

  // ---- High-fidelity post-processing pass --------------------------------
  // After the template builds its shapes, we scan the list and upgrade the
  // visual quality: add shadows to elevated surfaces, gradients to hero/CTA
  // shapes, and ensure consistent radii. This is what separates a "wireframe"
  // (flat grayscale boxes) from a "high-fidelity" design (elevated, colored,
  // with depth and polish). The LLM can further refine via pen_set_shadow /
  // pen_set_gradient_fill / pen_apply_palette, but this pass guarantees that
  // even a bare pen_generate_wireframe call produces a polished starting point.
  applyHighFidelityStyling(shapes, { PRIMARY, ACCENT, SURFACE, GRAY });

  return { frameId, shapes };
}

interface UserFlowResult {
  frameIds: string[];
  shapes: Array<Partial<Shape> & { id: string }>;
}

function buildUserFlow(flow: string, oxIn: number, oyIn: number): UserFlowResult {
  // Defensive: coerce to numbers — the LLM occasionally passes x/y as strings
  // (e.g. "100"), and string + number = string concatenation would place screens
  // at insane coordinates like (100455, 100). buildWireframe already does this,
  // but buildUserFlow was missing the coercion (bug: frames at x=1000, 100455, 100910).
  const ox = typeof oxIn === 'number' ? oxIn : Number(oxIn) || 80;
  const oy = typeof oyIn === 'number' ? oyIn : Number(oyIn) || 80;
  // Each step is a mobile screen (375 wide) with a 64px gap.
  const SCREEN_W = 375;
  const GAP = 80;
  const ARROW_COLOR = '#94a3b8';

  const flows: Record<string, string[]> = {
    // Onboarding: welcome → permissions → done (3 screens).
    // Each template is purpose-built for the onboarding step (not a generic login/signup).
    onboarding: ['mobile_welcome', 'mobile_permissions', 'mobile_done'],
    // Ecommerce: browse → product detail → cart → checkout (4 screens).
    ecommerce: ['mobile_browse', 'mobile_product_detail', 'mobile_cart', 'mobile_checkout'],
    // Auth: login → MFA → home (3 screens). Reuses mobile_dashboard for "home" since
    // a post-auth screen is typically the app's main dashboard.
    auth: ['mobile_login', 'mobile_dashboard', 'mobile_dashboard'],
    // Signup funnel: landing → signup → verify → dashboard (4 screens).
    // Verify reuses mobile_login visually (the verify-code screen is a form like login).
    signup_funnel: ['web_landing', 'mobile_signup', 'mobile_login', 'mobile_dashboard'],
  };
  const screens = flows[flow] ?? flows.onboarding;

  const frameIds: string[] = [];
  const shapes: Array<Partial<Shape> & { id: string }> = [];

  screens.forEach((tmpl, i) => {
    const sx = ox + i * (SCREEN_W + GAP);
    const wf = buildWireframe(tmpl, sx, oy);
    // Rename the frame to include the step number.
    wf.shapes[0] = { ...wf.shapes[0], name: `Step ${i + 1}` };
    shapes.push(...wf.shapes);
    frameIds.push(wf.frameId);

    // Add an arrow connector to the next screen.
    if (i < screens.length - 1) {
      const arrowStartX = sx + SCREEN_W;
      const arrowEndX = sx + SCREEN_W + GAP;
      const arrowY = oy + 300;
      shapes.push({
        id: crypto.randomUUID(),
        type: 'line',
        name: `Arrow ${i + 1}→${i + 2}`,
        x: arrowStartX,
        y: arrowY,
        width: arrowEndX - arrowStartX,
        height: 0,
        fill: ARROW_COLOR,
        stroke: ARROW_COLOR,
        strokeWidth: 2,
        radius: 0,
        fontSize: 14,
        textColor: ARROW_COLOR,
      });
    }
  });
  return { frameIds, shapes };
}

interface DiagramResult {
  shapes: Array<Partial<Shape> & { id: string }>;
}

function buildDiagram(template: string, labels: string[], oxIn: number, oyIn: number): DiagramResult {
  // Defensive: coerce to numbers — same reason as buildWireframe/buildUserFlow.
  const ox = typeof oxIn === 'number' ? oxIn : Number(oxIn) || 200;
  const oy = typeof oyIn === 'number' ? oyIn : Number(oyIn) || 100;
  const shapes: Array<Partial<Shape> & { id: string }> = [];
  const NODE_W = 160;
  const NODE_H = 56;
  const NODE_FILL = '#ffffff';
  const NODE_STROKE = '#475569';
  const ARROW = '#94a3b8';

  const addNode = (label: string, x: number, y: number) => {
    shapes.push({
      id: crypto.randomUUID(),
      type: 'rectangle',
      name: label,
      x, y, width: NODE_W, height: NODE_H,
      fill: NODE_FILL, stroke: NODE_STROKE, strokeWidth: 1, radius: 8,
      fontSize: 13, textColor: '#0f172a',
    });
    shapes.push({
      id: crypto.randomUUID(),
      type: 'text',
      name: `${label} label`,
      x: x + 12, y: y + 18, width: NODE_W - 24, height: 20,
      fill: 'transparent', text: label, fontSize: 13, textColor: '#0f172a',
      stroke: 'transparent', strokeWidth: 0, radius: 0,
    });
  };
  const addArrow = (x1: number, y1: number, x2: number, y2: number) => {
    shapes.push({
      id: crypto.randomUUID(),
      type: 'line',
      name: 'connector',
      x: x1, y: y1, width: x2 - x1, height: y2 - y1,
      fill: ARROW, stroke: ARROW, strokeWidth: 2, radius: 0,
      fontSize: 14, textColor: ARROW,
    });
  };

  if (template === 'flowchart') {
    // Top-down: each node centered, vertical arrow between.
    const cx = ox + 200;
    let cy = oy;
    const STEP = NODE_H + 60;
    labels.forEach((label, i) => {
      addNode(label, cx, cy);
      if (i < labels.length - 1) {
        addArrow(cx + NODE_W / 2, cy + NODE_H, cx + NODE_W / 2, cy + STEP);
      }
      cy += STEP;
    });
  } else {
    // Mindmap: central node + radial children.
    const cx = ox + 360;
    const cy = oy + 280;
    const centerLabel = labels[0];
    addNode(centerLabel, cx - NODE_W / 2, cy - NODE_H / 2);
    const radius = 220;
    const childCount = labels.length - 1;
    for (let i = 1; i < labels.length; i++) {
      const angle = (i - 1) / Math.max(1, childCount) * Math.PI * 2;
      const px = cx + Math.cos(angle) * radius - NODE_W / 2;
      const py = cy + Math.sin(angle) * radius - NODE_H / 2;
      addArrow(cx, cy, px + NODE_W / 2, py + NODE_H / 2);
      addNode(labels[i], px, py);
    }
  }
  return { shapes };
}

// ---- Copy generation variants ----------------------------------------------

const COPY_VARIANTS: Record<string, (topic: string) => string> = {
  heading: (t) => `The fastest way to ship ${t}`,
  subheading: (t) => `Everything you need to build, launch, and grow ${t} — without the busywork.`,
  body: (t) =>
    `${capitalize(t)} is changing fast. Teams that ship quickly win, and teams that don't fall behind. ` +
    `Our platform brings design, code, and feedback into one shared space, so you can move from idea to production ` +
    `in days, not months. Built for modern product teams who care about both speed and craft.`,
  button: (_t) => `Get started free`,
  caption: (t) => `A closer look at how ${t} works in practice.`,
  microcopy: (_t) => `We'll never share your email. Unsubscribe anytime.`,
};

// ---- Color utilities -------------------------------------------------------

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function luminance(hex: string): number {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}
