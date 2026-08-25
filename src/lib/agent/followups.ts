// followups.ts — contextual follow-up suggestion engine for the agent chat.
//
// After each completed agent turn, the AgentPanel shows 3-4 clickable
// "what next?" chips (the v0 / Lovable / Uizard pattern). Suggestions are
// derived from what the agent JUST did (tool trajectory) and the CURRENT
// canvas state — not a static list.
//
// Pure function: no React, no store access. Unit-testable.

import type { Shape, CanvasDocument } from '../canvas/types';

export interface FollowUpContext {
  /// Tool names used in the last turn (with success flags).
  tools: Array<{ name: string; success: boolean }>;
  /// The final text of the last assistant turn (lowercased for matching).
  assistantText: string;
  /// The prompt that triggered the turn (lowercased for matching).
  userPrompt: string;
  /// Current resolved layers (post-turn canvas state).
  shapes: Shape[];
  /// Whether the design has any color variables/tokens defined.
  hasColorVariables: boolean;
}

/// Suggest 3-4 follow-ups given the turn + canvas context.
/// Ordering = priority (most relevant first). Always returns 3-4 items.
export function suggestFollowUps(ctx: FollowUpContext): string[] {
  const out: string[] = [];
  const tools = ctx.tools.map((t) => t.name);
  const used = (n: string) => tools.includes(n);
  const prompt = `${ctx.userPrompt} ${ctx.assistantText}`;

  const isWireframe =
    /wireframe|low-fi|low fidelity|sketch|skeleton|graybox/.test(prompt) ||
    (used('pen_generate_wireframe') && !hasStylingPass(tools));
  const builtScreen = used('pen_generate_wireframe') || used('pen_generate_user_flow');
  const madePalette = used('pen_generate_palette') || used('pen_apply_palette');
  const textCount = ctx.shapes.filter((s) => s.type === 'text').length;
  const hasShadows = ctx.shapes.some((s) => s.shadow);
  const hasIcons = ctx.shapes.some((s) => (s.name ?? '').toLowerCase().includes('icon'));
  const frameCount = ctx.shapes.filter((s) => s.type === 'frame' || s.type === 'section').length;

  // --- High-relevance next steps based on what just happened ---

  if (isWireframe) {
    out.push('Upgrade this wireframe to a high-fidelity design with color, shadows, and real copy');
    out.push('Keep the layout but apply a modern SaaS palette with gradients');
  }

  if (builtScreen && !isWireframe) {
    out.push('Generate a 3-screen onboarding flow that follows this screen');
    if (!hasShadows) out.push('Add drop shadows to all cards and buttons');
  }

  if (madePalette) {
    out.push('Apply this palette to every shape and bind them as color tokens');
    out.push('Show me a dark-mode variant of this palette');
  }

  if (textCount > 0 && textCount < 4 && !isWireframe) {
    out.push('Fill in realistic copy for every text field');
  }

  if (frameCount >= 2) {
    out.push('Align all screens in a grid with even spacing');
  }

  if (used('pen_generate_user_flow')) {
    out.push('Add arrows with labels showing the flow direction');
  }

  if (used('figma_create_component') || used('pen_create_component') || used('pen_create_ref')) {
    out.push('Place 3 instances of this component with different text overrides');
  }

  if (ctx.shapes.length > 40) {
    out.push('Organize the layers — group related layers and give them clear names');
  }

  // --- Evergreen suggestions (fill remaining slots) ---

  const evergreen = [
    'Audit this design for contrast, alignment, and consistency issues',
    'Create a dark-mode version of this design',
    ...(!hasIcons && ctx.shapes.length > 8 ? ['Add lucide icons to nav items and buttons'] : []),
    ...(!ctx.hasColorVariables && ctx.shapes.length > 5
      ? ['Extract the colors into reusable design tokens']
      : []),
    'Export this design as SVG',
    'Design a matching empty-state screen for this product',
  ];

  for (const e of evergreen) {
    if (out.length >= 4) break;
    if (!out.includes(e)) out.push(e);
  }

  // De-dup, cap at 4.
  return [...new Set(out)].slice(0, 4);
}

function hasStylingPass(tools: string[]): boolean {
  return tools.some((t) =>
    t === 'pen_apply_palette' || t === 'pen_set_shadow' || t === 'pen_set_gradient_fill' ||
    t === 'pen_update_tokens' || t === 'pen_set_variables',
  );
}

/// Derive the FollowUpContext from live store state (convenience for the UI).
export function contextFromState(args: {
  tools: Array<{ name: string; success: boolean }>;
  assistantText: string;
  userPrompt: string;
  doc: CanvasDocument;
}): FollowUpContext {
  return {
    tools: args.tools,
    assistantText: args.assistantText.toLowerCase(),
    userPrompt: args.userPrompt.toLowerCase(),
    shapes: args.doc.shapes ?? [],
    hasColorVariables: Object.values(args.doc.variables ?? {}).some(
      (v) => (v as { type?: string })?.type === 'color',
    ),
  };
}
