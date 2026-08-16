// Skill registry — the 7 task-specific skills for the pi agent.
//
// Each skill is defined with:
//   - Level 1 metadata (name + description, ~100 tokens, always loaded)
//   - Level 2 body (full instructions, loaded on activation)
//   - allowedTools (which of the 56 canvas tools this skill exposes)
//   - keywords (for the intent classifier)
//
// The 7 skills were derived from the tool inventory analysis (see worklog.md,
// Task ID: assess-skills) and cover ~95% of user intents:
//
//   1. wireframe    — generate screens from descriptions
//   2. layout       — arrange/align/organize existing shapes
//   3. styling      — recolor/restyle/apply effects
//   4. inspect      — audit/analyze (read-only)
//   5. export       — export to code/SVG/PNG/JSON
//   6. web_research — web_search + web_fetch (sub-agent candidate)
//   7. vector       — paths/booleans/masks
//
// Core tools (always loaded regardless of skill):
//   canvas_create_shape, canvas_update_shape, canvas_delete_shape,
//   canvas_list_shapes, canvas_clear, canvas_set_background,
//   canvas_select_shape, canvas_undo, canvas_redo
//
// This reduces per-turn tool count from 56 → ~15-20 (core + one skill),
// well within the "safe zone" (<25 tools) identified by the research.

import type { Skill, SkillCategory } from './types';

// ---- Core tools (always loaded) -------------------------------------------
//
// These 9 tools are needed by every skill — you can't do anything without
// creating, updating, deleting, listing, or selecting shapes.

export const CORE_TOOL_NAMES = [
  'canvas_create_shape',
  'canvas_update_shape',
  'canvas_delete_shape',
  'canvas_list_shapes',
  'canvas_clear',
  'canvas_set_background',
  'canvas_select_shape',
  'canvas_undo',
  'canvas_redo',
] as const;

// ---- The 7 skills ----------------------------------------------------------

export const SKILLS: Record<SkillCategory, Skill | null> = {

  // 1. WIREFRAME — generate complete screens from descriptions
  wireframe: {
    id: 'wireframe',
    name: 'Wireframe Generation',
    description:
      'Generate complete UI screens and wireframes from natural-language descriptions. ' +
      'Use when the user asks to "design", "build", "create", or "make" a screen, page, ' +
      'dashboard, login form, landing page, or any multi-element layout. ' +
      'Produces well-structured shapes via template generators + manual placement.',
    body: `You are in WIREFRAME GENERATION mode. Your job is to produce a complete, visually
pleasing screen on the canvas from the user's description.

=== STRATEGY (follow this order) ==========================================

1. If the request matches a built-in template, call canvas_generate_wireframe FIRST.
   Templates: mobile_login, mobile_signup, mobile_dashboard, web_landing, web_dashboard,
   web_blog, web_pricing. This produces a well-structured starting point in one call.

2. If the request is a multi-screen flow (onboarding, ecommerce, auth, signup_funnel),
   call canvas_generate_user_flow instead.

3. If the request is a diagram (flowchart, mindmap), call canvas_generate_diagram.

4. After generating, use canvas_list_shapes to see what was created, then refine with
   canvas_update_shape (move/resize/recolor individual shapes).

5. Use canvas_generate_copy to fill text shapes with realistic placeholder copy.

6. Use canvas_apply_palette to apply a harmonious color scheme (or canvas_generate_palette
   first to create one from a base color).

7. Use canvas_search_icons to add Lucide icons (check, x, search, settings, user, etc.).

=== ARGUMENT RULES (CRITICAL — read before calling tools) =================

• palette MUST be an array of hex strings: ["#f8fafc", "#ffffff", ...]
  NEVER pass palette as a stringified JSON string. Pass it as a real JSON array.
  WRONG: "palette": "[\\"#fff\\", \\"#000\\"]"
  RIGHT: "palette": ["#fff", "#000"]

• All numeric args (x, y, width, height, fontSize) MUST be JSON numbers, not strings.
  WRONG: "x": "400"     RIGHT: "x": 400

• shapeIds / nodes / palette MUST be arrays, even for a single item.

=== LAYOUT TIPS ===========================================================

• Mobile screens are 375×667 px. Web screens are 1280×800 px.
• Place the first screen at (0, 0). Additional screens go at +475px (mobile) or +1380px (web).
• Use 16-24px padding inside frames. 8-12px gaps between elements.
• Headers: dark fill (#475569), white text. Cards: white fill, light gray stroke (#e2e8f0).
• Accent color: #0ea5e9 (sky blue) for CTAs and links.

=== COMPLETION CRITERIA ===================================================

The task is complete when the canvas shows a recognizable, well-structured screen that
matches the user's description. Do NOT spend more than 8-10 tool calls — the generator
tools are designed to produce most of the layout in one call. Refine selectively.`,
    allowedTools: [
      'canvas_generate_wireframe',
      'canvas_generate_user_flow',
      'canvas_generate_diagram',
      'canvas_generate_copy',
      'canvas_create_shape',
      'canvas_update_shape',
      'canvas_upload_image',
      'canvas_search_icons',
      'canvas_generate_image',
      'canvas_update_tokens',
      'canvas_apply_palette',
      'canvas_generate_palette',
    ],
    keywords: [
      'design', 'build', 'create', 'make', 'wireframe', 'mockup', 'screen',
      'page', 'landing', 'dashboard', 'login', 'signup', 'form', 'layout',
      'ui', 'interface', 'prototype', 'mock', 'template', 'flow', 'onboarding',
      'pricing', 'blog', 'ecommerce', 'app', 'mobile', 'web',
      'diagram', 'flowchart', 'mindmap', 'mind map',
    ],
  },

  // 2. LAYOUT — arrange, align, organize existing shapes
  layout: {
    id: 'layout',
    name: 'Layout & Organization',
    description:
      'Arrange, align, distribute, group, and organize existing shapes on the canvas. ' +
      'Use when the user asks to "align", "distribute", "center", "space out", "group", ' +
      '"organize layers", "reorder", "bring forward", "send backward", or apply auto-layout. ' +
      'Does NOT create new shapes — only repositions existing ones.',
    body: `You are in LAYOUT & ORGANIZATION mode. Your job is to arrange existing shapes on
the canvas — align, distribute, group, reorder, or apply auto-layout. You do NOT create
new shapes (if the user wants new shapes, that's the wireframe skill).

=== BEFORE YOU START ======================================================

Always call canvas_list_shapes FIRST to see what shapes exist and their current positions.
You need shape IDs to target them with layout operations.

=== TOOL SELECTION GUIDE ==================================================

• "align these shapes" → canvas_align_shapes (kind=left|right|center_h|top|bottom|center_v)
• "space them evenly" / "distribute" → canvas_align_shapes (kind=distribute_h|distribute_v)
• "group these" → canvas_group_shapes (wraps in a group shape)
• "ungroup" → canvas_ungroup_shapes
• "organize my layers" → canvas_organize_layers (auto-renames + re-zindexes everything)
• "duplicate this" → canvas_duplicate_shape (offsets 24px)
• "apply auto layout" → canvas_apply_auto_layout (direction, gap, padding, alignX, alignY)
• "bring to front" / "send to back" → canvas_bring_to_front / canvas_send_to_back
• "move forward" / "move backward" → canvas_move_forward / canvas_move_backward
• "lock this" / "unlock" → canvas_set_locked
• "hide this" / "show" → canvas_set_visible

=== ARGUMENT RULES ========================================================

• shapeIds MUST be an array of strings: ["id1", "id2", ...]
• For align_shapes, pass the shapeIds AND the kind.
• For auto_layout, pass the frame's shapeId + direction + gap + padding + alignX + alignY.

=== COMPLETION CRITERIA ===================================================

The task is complete when the shapes are arranged as the user requested. Typically 2-4
tool calls: list_shapes → align/group/organize → confirm.`,
    allowedTools: [
      'canvas_align_shapes',
      'canvas_group_shapes',
      'canvas_ungroup_shapes',
      'canvas_duplicate_shape',
      'canvas_organize_layers',
      'canvas_apply_auto_layout',
      'canvas_bring_to_front',
      'canvas_send_to_back',
      'canvas_move_forward',
      'canvas_move_backward',
      'canvas_reorder_shape',
      'canvas_set_locked',
      'canvas_set_visible',
    ],
    keywords: [
      'align', 'distribute', 'center', 'space', 'arrange', 'organize',
      'group', 'ungroup', 'reorder', 'bring forward', 'send backward',
      'bring to front', 'send to back', 'z-index', 'zorder', 'layer',
      'auto layout', 'lock', 'unlock', 'hide', 'show', 'visible',
      'duplicate', 'copy',
    ],
  },

  // 3. STYLING — recolor, restyle, apply effects
  styling: {
    id: 'styling',
    name: 'Styling & Effects',
    description:
      'Recolor, restyle, and apply visual effects to shapes. Use when the user asks to ' +
      '"recolor", "restyle", "change color", "apply palette", "add shadow", "add gradient", ' +
      '"add blur", "round corners", or work with design tokens. ' +
      'Includes palette generation, token binding, and per-corner radii.',
    body: `You are in STYLING & EFFECTS mode. Your job is to change the visual appearance of
existing shapes — colors, gradients, shadows, blurs, corner radii, and design tokens.

=== BEFORE YOU START ======================================================

Call canvas_list_shapes to see what exists. For token-based styling, call canvas_list_tokens
to see the current design tokens.

=== TOOL SELECTION GUIDE ==================================================

COLORS & PALETTES:
• "recolor everything" / "apply a new palette" → canvas_apply_palette
  CRITICAL: palette must be a REAL ARRAY of hex strings: ["#f8fafc", "#3b82f6", ...]
  NEVER pass palette as a string. Pass bindToTokens=true to also create color tokens.
• "generate a palette from this color" → canvas_generate_palette (baseColor, rule)
  rules: analogous, complementary, triadic, monochromatic, split_complementary
• "set up design tokens" → canvas_update_tokens (define named colors + text styles)
• "bind this shape to a token" → canvas_bind_shape_to_token
• "apply a token to shapes" → canvas_apply_token

EFFECTS:
• "add a gradient" → canvas_set_gradient_fill (type=linear|radial, angle, stops)
• "add a shadow" → canvas_set_shadow (x, y, blur, color, spread?, inset?)
• "add blur" → canvas_set_blur (radius in px)
• "round specific corners" → canvas_set_corner_radius_per_corner (topLeft, topRight, ...)

BULK:
• "update all shapes matching X" → canvas_bulk_update_by_filter (filter + changes)
• "find and replace text" → canvas_find_replace_text (find, replace)

=== ARGUMENT RULES (CRITICAL) ==============================================

• palette MUST be an array: ["#f8fafc", "#ffffff", "#f1f5f9", "#3b82f6", "#10b981"]
  WRONG (causes "Cannot read properties of undefined"): "palette": "[\\"#fff\\"]"
  RIGHT: "palette": ["#fff"]

• Colors are hex strings: "#ff0000" (with the # prefix).
• stops for gradients: [{offset: 0, color: "#fff"}, {offset: 1, color: "#000"}]
• blur is a number in pixels (e.g. 4 for a soft blur).

=== COMPLETION CRITERIA ===================================================

The task is complete when the shapes have the requested visual style. Typically 2-5 tool calls.`,
    allowedTools: [
      'canvas_apply_palette',
      'canvas_generate_palette',
      'canvas_update_tokens',
      'canvas_apply_token',
      'canvas_bind_shape_to_token',
      'canvas_unbind_shape',
      'canvas_list_tokens',
      'canvas_set_gradient_fill',
      'canvas_set_shadow',
      'canvas_set_blur',
      'canvas_set_corner_radius_per_corner',
      'canvas_find_replace_text',
      'canvas_bulk_update_by_filter',
    ],
    keywords: [
      'color', 'colour', 'recolor', 'restyle', 'retheme', 'palette',
      'gradient', 'shadow', 'blur', 'radius', 'corner', 'round',
      'token', 'design system', 'theme', 'tint', 'shade', 'fill',
      'stroke', 'opacity', 'effect', 'style',
    ],
  },

  // 4. INSPECT — audit, analyze, inspect (read-only)
  inspect: {
    id: 'inspect',
    name: 'Inspect & Analyze',
    description:
      'Audit, analyze, and inspect the canvas without modifying it. Use when the user asks to ' +
      '"audit", "check", "analyze", "inspect", "find", "list", "predict heatmap", ' +
      '"check consistency", "find issues", or "what shapes are on the canvas". ' +
      'Read-only — returns information as text, never mutates the canvas.',
    body: `You are in INSPECT & ANALYZE mode. Your job is to gather information about the canvas
and report it to the user. You do NOT modify the canvas — all tools in this skill are read-only.

=== TOOL SELECTION GUIDE ==================================================

• "what's on the canvas" / "list shapes" → canvas_list_shapes
• "find all rectangles" / "find shapes with fill X" → canvas_find_shapes
  filter by: type, fill, name, parentId
• "check my design" / "audit consistency" → canvas_audit_design
  Returns findings about: color drift, type scale issues, low-contrast text,
  token usage, alignment near-misses.
• "where will users look" / "predict attention" → canvas_predict_heatmap
  Pass a frame shapeId. Overlays a heatmap on that frame.
• "what tokens do I have" → canvas_list_tokens

=== REPORTING =============================================================

After calling the tool(s), summarize the findings clearly for the user:
• For audits, list each issue with severity (high/medium/low) and a suggested fix.
• For heatmaps, describe where attention is concentrated and what's being ignored.
• For find/list, give a concise summary (count + types) rather than dumping every shape.

=== COMPLETION CRITERIA ===================================================

The task is complete when you've reported the information the user asked for. Typically 1-2
tool calls. Do NOT make changes — if the user wants fixes, they'll ask in a follow-up.`,
    allowedTools: [
      'canvas_list_shapes',
      'canvas_find_shapes',
      'canvas_audit_design',
      'canvas_predict_heatmap',
      'canvas_list_tokens',
    ],
    keywords: [
      'audit', 'check', 'analyze', 'inspect', 'find', 'list', 'search',
      'heatmap', 'attention', 'consistency', 'issues', 'problems',
      'what shapes', 'show me', 'count', 'how many', 'where',
      'contrast', 'accessibility', 'a11y',
      'review my', 'review the', 'check my', 'check the',
    ],
    readOnly: true,
  },

  // 5. EXPORT — export to code/SVG/PNG/JSON
  export: {
    id: 'export',
    name: 'Export & Handoff',
    description:
      'Export the canvas or selected shapes to code (HTML/React/Tailwind), SVG, PNG, or JSON. ' +
      'Use when the user asks to "export", "download", "copy as code", "get the SVG", ' +
      '"generate HTML", or "hand off" the design. Returns the exported content as text.',
    body: `You are in EXPORT & HANDOFF mode. Your job is to convert the canvas into a deliverable
format: code, SVG, PNG, or JSON.

=== TOOL SELECTION GUIDE ==================================================

• "export as JSON" → canvas_export_json (full canvas document as JSON)
• "get the SVG" → canvas_export_svg (optional frameId to export just one frame)
• "export as PNG" → canvas_export_png (returns an SVG data URL renderable in browsers)
• "copy as code" / "generate HTML" / "give me React" → canvas_copy_as_code
  format: "html" | "react" | "tailwind"

=== REPORTING =============================================================

After calling the tool, present the result to the user:
• For code exports, show the code in a code block.
• For SVG/PNG, tell the user the data URL or that it's been generated.
• For JSON, summarize the structure (N shapes, M tokens).

=== COMPLETION CRITERIA ===================================================

The task is complete when the exported content has been generated and presented. Typically
1 tool call. Do NOT modify the canvas — export is read-only.`,
    allowedTools: [
      'canvas_export_json',
      'canvas_export_svg',
      'canvas_export_png',
      'canvas_copy_as_code',
    ],
    keywords: [
      'export', 'download', 'copy as code', 'svg', 'png', 'json',
      'html', 'react', 'tailwind', 'code', 'handoff', 'hand off',
      'generate code', 'convert', 'save',
    ],
    readOnly: true,
  },

  // 6. WEB_RESEARCH — web_search + web_fetch (sub-agent candidate)
  web_research: {
    id: 'web_research',
    name: 'Web Research',
    description:
      'Search the web for current information and fetch webpage content. Use when the user ' +
      'asks about "current", "recent", "latest", "2024", "2025", real-world products, ' +
      'design trends, or anything not in your training data. ' +
      'Works with zero configuration — no API key needed. ' +
      'Dispatched to a sub-agent to keep intermediate page content out of the main context.',
    body: `You are in WEB RESEARCH mode. Your job is to find current information on the web and
report it to the user (or use it to inform a subsequent design task).

=== TOOL SELECTION GUIDE ==================================================

• "search for X" / "what's new in Y" → web_search (query, optional recency)
  recency: "day" | "week" | "month" | "year" (omit for no filter)
  Returns numbered results with title, URL, snippet, publish date.

• "read this page" / "fetch this URL" → web_fetch (url)
  Returns the page content as clean readable markdown.
  Handles HTML, JSON, RSS/Atom feeds, and JS-rendered pages.

=== STRATEGY =============================================================

1. Start with web_search to find relevant sources.
2. If you need more detail than the snippet, call web_fetch on the most relevant URL.
3. You can call web_search multiple times with different queries.
4. Synthesize the findings into a clear summary for the user.

=== ARGUMENT RULES ========================================================

• query: a plain natural-language string (same as you'd type into Google).
• url: a plain string (https://example.com/page or bare example.com).
• recency: omit for no filter, or use "day"/"week"/"month"/"year".

=== COMPLETION CRITERIA ===================================================

The task is complete when you've found and reported the information the user asked about.
Typically 2-4 tool calls (1-2 searches + 1-2 fetches). Do NOT fetch more than 3-4 pages —
synthesize from what you have.`,
    allowedTools: [
      'web_search',
      'web_fetch',
    ],
    keywords: [
      'search', 'web', 'internet', 'look up', 'find online', 'research',
      'current', 'recent', 'latest', '2024', '2025', '2026',
      'news', 'trend', 'trends', 'real-world', 'actual',
      'website', 'url', 'link', 'fetch', 'read page',
      'what is', 'how does', 'compare', 'versus', 'vs',
      "what's new", 'whats new', 'what\u2019s new',
      'look up', 'find out', 'tell me about',
    ],
    readOnly: true,
    useSubAgent: true,
  },

  // 7. VECTOR — paths, boolean ops, masks
  vector: {
    id: 'vector',
    name: 'Vector Editing',
    description:
      'Create freeform paths, polygons, and custom vector shapes. Use when the user asks to ' +
      '"draw a path", "make a polygon", "boolean combine", "union", "subtract", "intersect", ' +
      '"mask", "clip", or create custom vector artwork. ' +
      'Specialized for advanced shape manipulation beyond basic rectangles/ellipses.',
    body: `You are in VECTOR EDITING mode. Your job is to create custom vector shapes — paths,
polygons, and boolean combinations — that go beyond the basic rectangle/ellipse/text shapes.

=== TOOL SELECTION GUIDE ==================================================

• "draw a path" / "make a polygon" → canvas_create_path
  Pass an array of {x, y} points. Set closed=true for a filled polygon,
  closed=false for a stroked polyline.

• "combine these shapes" / "union" → canvas_boolean_op (operation="union")
• "subtract" → canvas_boolean_op (operation="subtract")
• "intersect" → canvas_boolean_op (operation="intersect")
• "exclude" → canvas_boolean_op (operation="exclude")
  Pass shapeId1 + shapeId2. The result replaces shapeId1.

• "mask this with that" / "clip" → canvas_mask_with
  Pass shapeId (the content) + maskId (the clipping shape).
  The content shape is clipped to the mask shape's geometry.

=== ARGUMENT RULES ========================================================

• points MUST be an array of {x, y} objects: [{"x": 0, "y": 0}, {"x": 100, "y": 0}, ...]
  NEVER pass points as a stringified JSON string.
• For boolean_op, both shapeId1 and shapeId2 are required.
• For mask_with, both shapeId and maskId are required.

=== COMPLETION CRITERIA ===================================================

The task is complete when the custom vector shape has been created. Typically 1-3 tool calls.`,
    allowedTools: [
      'canvas_create_path',
      'canvas_boolean_op',
      'canvas_mask_with',
      'canvas_create_shape',
      'canvas_update_shape',
    ],
    keywords: [
      'path', 'polygon', 'polyline', 'vector', 'freeform', 'custom shape',
      'boolean', 'union', 'subtract', 'intersect', 'exclude',
      'mask', 'clip', 'clipping', 'crop',
      'points', 'vertices', 'curve',
    ],
  },

  // MULTI — fallback: load all skills (used when intent is ambiguous)
  multi: null,
};

// ---- Skill metadata (Level 1 — always loaded) -----------------------------
//
// Returns just the name + description for each skill. This is what the system
// prompt includes at startup so the model knows what skills exist.
// ~100 tokens per skill × 7 skills = ~700 tokens total.

export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
}

export function getSkillMetadata(): SkillMetadata[] {
  return (Object.values(SKILLS).filter(Boolean) as Skill[]).map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
  }));
}

// ---- Get a skill by category -----------------------------------------------

export function getSkill(category: SkillCategory): Skill | null {
  return SKILLS[category];
}

// ---- Get the tool names for a category ------------------------------------
//
// Returns the skill's allowedTools. For 'multi', returns ALL tool names
// (the full 56-tool flat list — the fallback when intent is ambiguous).

export function getToolNamesForCategory(category: SkillCategory): string[] {
  if (category === 'multi') {
    return ALL_TOOL_NAMES as string[];
  }
  const skill = SKILLS[category];
  if (!skill) return CORE_TOOL_NAMES as string[];
  // Core tools are always included + skill-specific tools (deduped).
  const combined = new Set<string>([...CORE_TOOL_NAMES, ...skill.allowedTools]);
  return [...combined];
}

// ---- All tool names (for the 'multi' fallback) -----------------------------
//
// This list mirrors the tools returned by `createCanvasTools()` in tools.ts.
// If a new tool is added there, it MUST be added here too.

export const ALL_TOOL_NAMES = [
  // Core
  'canvas_create_shape', 'canvas_update_shape', 'canvas_delete_shape',
  'canvas_list_shapes', 'canvas_clear', 'canvas_set_background', 'canvas_select_shape',
  // Layout
  'canvas_duplicate_shape', 'canvas_group_shapes', 'canvas_ungroup_shapes',
  'canvas_align_shapes', 'canvas_organize_layers', 'canvas_apply_auto_layout',
  // Components
  'canvas_create_component', 'canvas_instantiate_component',
  // Tokens / palette
  'canvas_update_tokens', 'canvas_apply_palette', 'canvas_generate_palette',
  // Generators
  'canvas_generate_wireframe', 'canvas_generate_user_flow', 'canvas_generate_diagram',
  // Analysis
  'canvas_predict_heatmap', 'canvas_generate_copy', 'canvas_audit_design',
  // Token binding
  'canvas_bind_shape_to_token', 'canvas_unbind_shape', 'canvas_list_tokens', 'canvas_apply_token',
  // Lock & visibility
  'canvas_set_locked', 'canvas_set_visible',
  // Z-order
  'canvas_bring_to_front', 'canvas_send_to_back', 'canvas_move_forward', 'canvas_move_backward',
  'canvas_reorder_shape',
  // Undo / redo
  'canvas_undo', 'canvas_redo',
  // Export
  'canvas_export_json', 'canvas_export_svg', 'canvas_export_png', 'canvas_copy_as_code',
  // Find & filter
  'canvas_find_shapes', 'canvas_bulk_update_by_filter', 'canvas_find_replace_text',
  // Vector
  'canvas_create_path', 'canvas_boolean_op', 'canvas_mask_with',
  // Effects
  'canvas_set_gradient_fill', 'canvas_set_shadow', 'canvas_set_blur',
  'canvas_set_corner_radius_per_corner',
  // Images
  'canvas_upload_image', 'canvas_search_icons', 'canvas_generate_image',
  // Web research
  'web_search', 'web_fetch',
] as const;

// ---- Format skill metadata for the system prompt --------------------------
//
// Produces a compact XML-tagged block listing all available skills.
// This is Tier 0 (prompt reorganization) + Tier 2 (progressive disclosure
// Level 1) combined.

export function formatSkillMetadataForPrompt(): string {
  const metadata = getSkillMetadata();
  const lines = metadata.map((s) =>
    `  <skill id="${s.id}">
     name: ${s.name}
     when: ${s.description}
   </skill>`,
  );
  return `<available_skills>
${lines.join('\n')}
</available_skills>`;
}

// ---- Format a skill body for the system prompt (Level 2) ------------------
//
// Produces the full task-specific instructions for an activated skill.
// This is injected into the system prompt when the skill is active.

export function formatSkillBodyForPrompt(category: SkillCategory): string {
  if (category === 'multi') {
    return ''; // No skill-specific body — all tools are available.
  }
  const skill = SKILLS[category];
  if (!skill) return '';
  return `<active_skill id="${skill.id}">
${skill.body}
</active_skill>`;
}
