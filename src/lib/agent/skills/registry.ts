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
//   pen_create_shape, pen_update_shape, pen_delete_shape,
//   pen_list_shapes, pen_clear, pen_set_background,
//   pen_select_shape, pen_undo, pen_redo
//
// This reduces per-turn tool count from 56 → ~15-20 (core + one skill),
// well within the "safe zone" (<25 tools) identified by the research.

import type { Skill, SkillCategory } from './types';

// ---- Core tools (always loaded) -------------------------------------------
//
// These 9 tools are needed by every skill — you can't do anything without
// creating, updating, deleting, listing, or selecting shapes.

export const CORE_TOOL_NAMES = [
  'pen_create_shape',
  'pen_update_shape',
  'pen_delete_shape',
  'pen_list_shapes',
  'pen_clear',
  'pen_set_background',
  'pen_select_shape',
  'pen_undo',
  'pen_redo',
] as const;

// ---- The 7 skills ----------------------------------------------------------

export const SKILLS: Record<SkillCategory, Skill | null> = {

  // 1. WIREFRAME / DESIGN — generate complete, HIGH-FIDELITY screens from descriptions
  wireframe: {
    id: 'wireframe',
    name: 'Design Generation',
    description:
      'Generate complete, HIGH-FIDELITY UI screens from natural-language descriptions. ' +
      'Use when the user asks to "design", "build", "create", or "make" a screen, page, ' +
      'dashboard, login form, landing page, or any multi-element layout. ' +
      'Produces production-ready designs with full color, shadows, gradients, real content, ' +
      'and design tokens — NOT bare wireframes (wireframes only on explicit request).',
    body: `You are in DESIGN GENERATION mode. Your job is to produce a complete, HIGH-FIDELITY,
production-ready screen on the canvas from the user's description. A high-fidelity design has full
color, drop shadows on elevated surfaces, gradients on hero/CTA, realistic content, a consistent
type scale, 8px spacing, and bound design tokens. A grayscale flat layout with no shadows is a
WIREFRAME — only produce that if the user explicitly says "wireframe", "low-fi", "sketch", etc.

=== STRATEGY (follow this order — every step matters) =====================

1. SCAFFOLD: If the request matches a built-in template, call pen_generate_wireframe FIRST.
   Templates: mobile_login, mobile_signup, mobile_dashboard, mobile_welcome, mobile_permissions,
   mobile_done, mobile_browse, mobile_product_detail, mobile_cart, mobile_checkout, web_landing,
   web_dashboard, web_blog, web_pricing. This produces a structured starting point in one call.
   The generator now emits high-fidelity styling (shadows, gradients, radii, real content) by default.
   If the request is a multi-screen flow (onboarding, ecommerce, auth, signup_funnel), call
   pen_generate_user_flow instead. If it's a diagram (flowchart, mindmap), call pen_generate_diagram.

2. LIST: After generating, call pen_list_shapes to see what was created + their IDs.
   IMPORTANT: copy shape IDs verbatim from the pen_list_shapes output — do NOT wrap them in
   arrays or quotes-within-quotes. The shapeId parameter is a plain STRING, e.g. "abc-123",
   NOT ["abc-123"].

3. TOKENIZE: Define the semantic color tokens via pen_set_variable (or pen_update_tokens).
   Required tokens: $color.bg, $color.surface, $color.surface-2, $color.border, $color.text,
   $color.text-muted, $color.primary, $color.primary-fg, $color.accent, $color.success, $color.danger.
   Use the values from the HIGH-FIDELITY DESIGN SYSTEM in your system prompt.

4. PALETTE: Call pen_apply_palette with bindToTokens=true to bind shapes to the tokens and apply a
   harmonious 60-30-10 palette. Default palette: bg #f8fafc, surface #ffffff, surface-2 #f1f5f9,
   border #e2e8f0, text #0f172a, text-muted #475569, primary #0ea5e9, accent #6366f1,
   success #10b981, danger #ef4444. Adjust the accent to fit the domain (fintech → emerald, health →
   teal, creative → violet) unless the user specified colors.

5. ELEVATE (CRITICAL — this is what separates hifi from wireframe): Add drop shadows to every
   elevated surface via pen_set_shadow. Cards get shadow "0 4 6 -1 #0000001a". Buttons get
   "0 2 4 -1 #0000001a". Modals/dialogs get "0 20 25 -5 #00000033". FABs get "0 8 12 -4 #00000033".
   Use pen_bulk_update_by_filter to find all shapes named "Card*" or "Button*" and batch-style them
   if you don't want to call pen_set_shadow one at a time. A design with ZERO shadows is incomplete.

6. GRADIENTS: Add a gradient via pen_set_gradient_fill to the hero area, primary CTA, or logo mark.
   Example: linear, angle 135, stops [{offset:0, color:"#0ea5e9"}, {offset:1, color:"#6366f1"}].
   Do NOT gradient body text or the full page background.

7. CONTENT: Replace placeholder text ("Lorem ipsum", "Item 1", "Label", "Heading") with realistic
   domain copy via pen_generate_copy or pen_update_shape (text field). Use real names ("Sarah Chen"),
   real numbers ("$12,480", "+18.2%"), real labels ("Monthly revenue"). NEVER leave "Lorem ipsum" on
   a high-fidelity design.

8. ICONS: Add lucide icons (pen_search_icons) for nav items, buttons, stat indicators. Stroke width 2,
   size 20-24. Do NOT use emoji as icons.

9. COMPONENTIZE: After generating, if you see 3+ similar shapes (e.g. 4 stat cards, 3 list items),
   call pen_recommend_components to find repeated patterns, then pen_convert_to_component on one of
   them, and pen_place_component_instance + pen_override_instance to replace the others with linked
   instances. This closes the gap vs Figma AI: proactively suggest componentization.

10. HIERARCHY: when the prompt asks to "move X into a (new) frame" or "reparent X", FIRST create the
    target frame with pen_create_shape, THEN call pen_reparent_shape to move the existing shape into it.
    pen_reparent_shape preserves the shape's absolute canvas position by default — pass
    keepAbsolutePosition=false if you want the stored relative x/y reinterpreted verbatim against the
    new parent. Do NOT pass a "parent" field to pen_update_shape — that field is silently ignored;
    always use pen_reparent_shape for reparenting.

11. SELF-CRITIQUE (MANDATORY for high-fidelity work): After the design is complete, call
    pen_self_critique to get a senior-designer review. The critic will score wireframe-only output
    (no shadows, no gradients, grayscale) at 4/10 or below — so if your first pass scored low, add
    the missing shadows/gradients/content and re-critique. Address every [BLOCKER] and [MAJOR]
    finding before finalizing. Skip this ONLY if the user explicitly asked for a quick wireframe.

=== ARGUMENT RULES (CRITICAL — read before calling tools) =================

• palette MUST be an array of hex strings: ["#f8fafc", "#ffffff", ...]
  NEVER pass palette as a stringified JSON string. Pass it as a real JSON array.
  WRONG: "palette": "[\\"#fff\\", \\"#000\\"]"
  RIGHT: "palette": ["#fff", "#000"]

• All numeric args (x, y, width, height, fontSize) MUST be JSON numbers, not strings.
  WRONG: "x": "400"     RIGHT: "x": 400

• shapeId MUST be a single string, NOT an array.
  WRONG: "shapeId": ["abc-123"]   or   "shapeId": "[\\"abc-123\\"]"
  RIGHT: "shapeId": "abc-123"
  (shapeIds plural — used by group/align/etc. — is an array.)

• Shadow color uses 8-digit hex with alpha: #0000001a = black at 10% opacity.
  Pass x, y, blur as numbers; spread defaults to 0; inset defaults to false.

• Gradient stops: [{offset: 0, color: "#0ea5e9"}, {offset: 1, color: "#6366f1"}].
  offset is 0..1. At least 2 stops required.

• If a tool call returns "Error: no shape with id X", call pen_list_shapes to see the actual IDs.
  Do NOT retry the same call with the same ID — that loops forever.

=== LAYOUT & AESTHETIC TIPS ===============================================

• Mobile screens are 375×812 px (iPhone X+ aspect). Web screens are 1280×800 px.
• Place the first screen at (100, 100). Additional screens go at +475px (mobile) or +1380px (web).
• Use 16-24px padding inside frames. 8-12px gaps between elements. Section gaps 24-32px.
• Mobile dashboard best practices (2025):
  - 4 stat cards (2×2 grid) with trend indicators (↑↓ +X%), each with a shadow + 12px radius
  - Status bar (44px) at top + header with menu/avatar (56px)
  - Chart card with sketched axes + line/bars hint + shadow
  - 3+ list items showing the repeating pattern (component reuse)
  - Bottom tab bar with 4 tabs (lucide icon + label each), active state highlighted in primary color
  - Floating Action Button (FAB) for quick actions, with elevation shadow
  - Home indicator (iOS bottom safe area)
• Accent color: #0ea5e9 (sky) by default. Vary by domain: fintech #10b981, health #14b8a6,
  creative #8b5cf6, enterprise #6366f1. NEVER use plain blue/indigo unless the user asks.
• Success trend: #10b981 (emerald). Danger trend: #ef4444 (red). Warning: #f59e0b (amber).

=== COMPLETION CRITERIA ===================================================

The task is complete ONLY when ALL of these are true:
  ✓ The canvas shows a recognizable, well-structured screen matching the user's description.
  ✓ Every card/button/modal has a drop shadow (no flat surfaces except page bg).
  ✓ A color palette is applied (not grayscale) and bound to tokens.
  ✓ At least one gradient is present on the hero/CTA/logo.
  ✓ All text is realistic domain copy (no "Lorem ipsum", no "Item 1").
  ✓ The self-critique returned no outstanding [BLOCKER] findings.

A bare generate_wireframe output with no styling pass is NOT complete — do not stop there.
Budget ~15-25 tool calls for a proper high-fidelity screen. If a tool fails 2x in a row, switch
to a different approach (do NOT loop on the same failing call).`,
    allowedTools: [
      // Task 7-g Fix 2 — pen_generate_design_brief MUST be first per the
      // brief-first enforcement in runner-native.ts. Without this entry the
      // runner's `filteredTools = allTools.filter(t => allowedToolNames.has(t.name))`
      // filters pen_generate_design_brief OUT, so when Fix 2 (Task 7-e) rejects
      // the first pen_generate_wireframe call, the agent's recovery attempt to
      // call pen_generate_design_brief fails with "Tool not found" → empty canvas.
      'pen_generate_design_brief',
      'pen_generate_wireframe',
      'pen_generate_user_flow',
      'pen_generate_diagram',
      'pen_generate_copy',
      'pen_create_shape',
      'pen_update_shape',
      'pen_upload_image',
      'pen_search_icons',
      'pen_generate_image',
      // ---- Styling tools (REQUIRED for high-fidelity output) ----
      // Without these in the wireframe skill, the LLM cannot add shadows,
      // gradients, blur, or per-corner radii — producing flat wireframes.
      'pen_set_gradient_fill',
      'pen_set_shadow',
      'pen_set_blur',
      'pen_set_corner_radius_per_corner',
      // ---- Token / palette tools ----
      'pen_update_tokens',
      'pen_apply_palette',
      'pen_generate_palette',
      'pen_apply_token',
      'pen_bind_shape_to_token',
      'pen_unbind_shape',
      'pen_list_tokens',
      'pen_set_variable',
      // ---- Layout tools (needed for auto-layout + reparenting post-generation) ----
      'pen_apply_auto_layout',
      'pen_align_shapes',
      'pen_reparent_shape',
      'pen_duplicate_shape',
      'pen_group_shapes',
      'pen_ungroup_shapes',
      'pen_bring_to_front',
      'pen_send_to_back',
      'pen_move_forward',
      'pen_move_backward',
      'pen_bulk_update_by_filter',
      'pen_find_replace_text',
      'pen_find_shapes',
      // Figma-hierarchy: post-generation refinement often involves moving
      // shapes between frames (e.g. "design X then move Y into a new frame").
      'pen_set_constraints',
      // Phase 3 agentic workflows — MANDATORY post-generation:
      'pen_recommend_components',
      'pen_convert_to_component',
      'pen_place_component_instance',
      'pen_override_instance',
      'pen_self_critique',
      'pen_list_shapes',
    ],
    keywords: [
      'design', 'build', 'create', 'make', 'wireframe', 'mockup', 'screen',
      'page', 'landing', 'dashboard', 'login', 'signup', 'form', 'layout',
      'ui', 'interface', 'prototype', 'mock', 'template', 'flow', 'onboarding',
      'pricing', 'blog', 'ecommerce', 'app', 'mobile', 'web',
      'diagram', 'flowchart', 'mindmap', 'mind map',
      'high fidelity', 'hifi', 'high-fi', 'polished', 'production-ready',
      'beautiful', 'modern', 'redesign', 'skin', 'theme',
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

Always call pen_list_shapes FIRST to see what shapes exist and their current positions.
You need shape IDs to target them with layout operations.

=== TOOL SELECTION GUIDE ==================================================

• "align these shapes" → pen_align_shapes (kind=left|right|center_h|top|bottom|center_v)
• "space them evenly" / "distribute" → pen_align_shapes (kind=distribute_h|distribute_v)
• "group these" → pen_group_shapes (wraps in a group shape)
• "ungroup" → pen_ungroup_shapes (children promoted to grandparent, abs pos preserved)
• "organize my layers" → pen_organize_layers (auto-renames + re-zindexes everything)
• "duplicate this" → pen_duplicate_shape (offsets 24px)
• "apply auto layout" → pen_apply_auto_layout (direction, gap, padding, alignX, alignY)
• "bring to front" / "send to back" → pen_bring_to_front / pen_send_to_back
• "move forward" / "move backward" → pen_move_forward / pen_move_backward
• "lock this" / "unlock" → pen_set_locked
• "hide this" / "show" → pen_set_visible

HIERARCHY (Figma-style nesting):
• "move X into Y" / "reparent X to Y" → pen_reparent_shape (shapeId, newParentId)
  - newParentId null/empty = promote to root (top-level)
  - Default keepAbsolutePosition=true — the shape stays put visually (its stored
    relative x/y is remapped to the new parent's coordinate frame).
  - Rejects reparenting into self or a descendant (cycle prevention).
  - DO NOT use pen_update_shape with a "parent" field — that field is silently
    ignored. Always use pen_reparent_shape.
• "set constraints" / "pin to edges" → pen_set_constraints (shapeId, horizontal, vertical)
  - horizontal: left | right | center | scale | left_right
  - vertical:   top  | bottom | center | scale | top_bottom
  - Stored on the node; the renderer does not yet enforce these but the agent
    and the Properties panel can read/edit them for responsive-resize intent.

=== ARGUMENT RULES ========================================================

• shapeIds MUST be an array of strings: ["id1", "id2", ...]
• For align_shapes, pass the shapeIds AND the kind.
• For auto_layout, pass the frame's shapeId + direction + gap + padding + alignX + alignY.

=== COMPLETION CRITERIA ===================================================

The task is complete when the shapes are arranged as the user requested. Typically 2-4
tool calls: list_shapes → align/group/organize → confirm.`,
    allowedTools: [
      // Task 7-g Fix 3 — design prompts can route through layout (e.g. 'redesign the layout'),
      // and pen_set_variable (gated by brief-first) is always loaded via PEN_TOOL_NAMES —
      // so layout must include pen_generate_design_brief so the agent can recover from the rejection.
      'pen_generate_design_brief',
      'pen_align_shapes',
      'pen_group_shapes',
      'pen_ungroup_shapes',
      'pen_duplicate_shape',
      'pen_organize_layers',
      'pen_apply_auto_layout',
      'pen_bring_to_front',
      'pen_send_to_back',
      'pen_move_forward',
      'pen_move_backward',
      'pen_reorder_shape',
      'pen_set_locked',
      'pen_set_visible',
      // Figma-hierarchy ops — natural home for reparent + constraints.
      // Reparent moves a shape between parents (preserves absolute position
      // by default); constraints pin a child's edges to its parent for
      // responsive resize.
      'pen_reparent_shape',
      'pen_set_constraints',
    ],
    keywords: [
      'align', 'distribute', 'center', 'space', 'arrange', 'organize',
      'group', 'ungroup', 'reorder', 'bring forward', 'send backward',
      'bring to front', 'send to back', 'z-index', 'zorder', 'layer',
      'auto layout', 'lock', 'unlock', 'hide', 'show', 'visible',
      'duplicate', 'copy',
      // Figma-hierarchy triggers: "move X into Y", "reparent", "container",
      // "into a frame" — these verbs should make layout a secondary skill
      // (alongside the primary wireframe/styling/etc.) so the LLM gets
      // pen_reparent_shape in its tool list.
      'move', 'reparent', 'container', 'into', 'nest', 'parent',
      'constraints', 'pin', 'resize',
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

Call pen_list_shapes to see what exists. For token-based styling, call pen_list_tokens
to see the current design tokens.

=== TOOL SELECTION GUIDE ==================================================

COLORS & PALETTES:
• "recolor everything" / "apply a new palette" → pen_apply_palette
  CRITICAL: palette must be a REAL ARRAY of hex strings: ["#f8fafc", "#3b82f6", ...]
  NEVER pass palette as a string. Pass bindToTokens=true to also create color tokens.
• "generate a palette from this color" → pen_generate_palette (baseColor, rule)
  rules: analogous, complementary, triadic, monochromatic, split_complementary
• "set up design tokens" → pen_update_tokens (define named colors + text styles)
• "bind this shape to a token" → pen_bind_shape_to_token
• "apply a token to shapes" → pen_apply_token

EFFECTS:
• "add a gradient" → pen_set_gradient_fill (type=linear|radial, angle, stops)
• "add a shadow" → pen_set_shadow (x, y, blur, color, spread?, inset?)
• "add blur" → pen_set_blur (radius in px)
• "round specific corners" → pen_set_corner_radius_per_corner (topLeft, topRight, ...)

BULK:
• "update all shapes matching X" → pen_bulk_update_by_filter (filter + changes)
• "find and replace text" → pen_find_replace_text (find, replace)

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
      // Task 7-g Fix 3 — pen_apply_palette is gated by brief-first enforcement; without
      // pen_generate_design_brief in this skill's allowedTools, the agent would hit the rejection
      // with no recovery path (Task 7-f regression).
      'pen_generate_design_brief',
      'pen_apply_palette',
      'pen_generate_palette',
      'pen_update_tokens',
      'pen_apply_token',
      'pen_bind_shape_to_token',
      'pen_unbind_shape',
      'pen_list_tokens',
      'pen_set_gradient_fill',
      'pen_set_shadow',
      'pen_set_blur',
      'pen_set_corner_radius_per_corner',
      'pen_find_replace_text',
      'pen_bulk_update_by_filter',
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
      '"audit", "check", "analyze", "inspect", "find", "list", ' +
      '"check consistency", "find issues", or "what shapes are on the canvas". ' +
      'Read-only — returns information as text, never mutates the canvas.',
    body: `You are in INSPECT & ANALYZE mode. Your job is to gather information about the canvas
and report it to the user. You do NOT modify the canvas — all tools in this skill are read-only.

=== TOOL SELECTION GUIDE ==================================================

• "what's on the canvas" / "list shapes" → pen_list_shapes
• "find all rectangles" / "find shapes with fill X" → pen_find_shapes
  filter by: type, fill, name, parentId
• "check my design" / "audit consistency" → pen_audit_design
  Returns findings about: color drift, type scale issues, low-contrast text,
  token usage, alignment near-misses.
• "what tokens do I have" → pen_list_tokens

=== REPORTING =============================================================

After calling the tool(s), summarize the findings clearly for the user:
• For audits, list each issue with severity (high/medium/low) and a suggested fix.
• For find/list, give a concise summary (count + types) rather than dumping every shape.

=== COMPLETION CRITERIA ===================================================

The task is complete when you've reported the information the user asked for. Typically 1-2
tool calls. Do NOT make changes — if the user wants fixes, they'll ask in a follow-up.`,
    allowedTools: [
      // Task 7-g Fix 3 — read-only analysis skill still receives gated tools via
      // CORE_TOOL_NAMES (pen_create_shape) + PEN_TOOL_NAMES (pen_set_variable) in
      // the runner's allowedToolNames union, so pen_generate_design_brief must be
      // present for the brief-first recovery path (Task 7-f regression).
      'pen_generate_design_brief',
      'pen_list_shapes',
      'pen_find_shapes',
      'pen_audit_design',
      'pen_list_tokens',
    ],
    keywords: [
      'audit', 'check', 'analyze', 'inspect', 'find', 'list', 'search',
      'consistency', 'issues', 'problems',
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

• "export as JSON" → pen_export_json (full canvas document as JSON)
• "get the SVG" → pen_export_svg (optional frameId to export just one frame)
• "export as PNG" → pen_export_png (returns an SVG data URL renderable in browsers)
• "copy as code" / "generate HTML" / "give me React" → pen_copy_as_code
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
      // Task 7-g Fix 3 — export skill still receives gated tools via
      // CORE_TOOL_NAMES (pen_create_shape) + PEN_TOOL_NAMES (pen_set_variable) in
      // the runner's allowedToolNames union, so pen_generate_design_brief must be
      // present for the brief-first recovery path (Task 7-f regression).
      'pen_generate_design_brief',
      'pen_export_json',
      'pen_export_svg',
      'pen_export_png',
      'pen_copy_as_code',
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
      // Task 7-g Fix 3 — research skill still receives gated tools via
      // CORE_TOOL_NAMES (pen_create_shape) + PEN_TOOL_NAMES (pen_set_variable) in
      // the runner's allowedToolNames union, so pen_generate_design_brief must be
      // present for the brief-first recovery path (Task 7-f regression).
      'pen_generate_design_brief',
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

• "draw a path" / "make a polygon" → pen_create_path
  Pass an array of {x, y} points. Set closed=true for a filled polygon,
  closed=false for a stroked polyline.

• "combine these shapes" / "union" → pen_boolean_op (operation="union")
• "subtract" → pen_boolean_op (operation="subtract")
• "intersect" → pen_boolean_op (operation="intersect")
• "exclude" → pen_boolean_op (operation="exclude")
  Pass shapeId1 + shapeId2. The result replaces shapeId1.

• "mask this with that" / "clip" → pen_mask_with
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
      // Task 7-g Fix 3 — vector skill includes pen_create_shape (gated by brief-first enforcement),
      // so pen_generate_design_brief must be available for the recovery path.
      'pen_generate_design_brief',
      'pen_create_path',
      'pen_boolean_op',
      'pen_mask_with',
      'pen_create_shape',
      'pen_update_shape',
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
    return [...ALL_TOOL_NAMES];
  }
  const skill = SKILLS[category];
  if (!skill) return [...CORE_TOOL_NAMES];
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
  'pen_create_shape', 'pen_update_shape', 'pen_delete_shape',
  'pen_list_shapes', 'pen_clear', 'pen_set_background', 'pen_select_shape',
  // Layout
  'pen_duplicate_shape', 'pen_group_shapes', 'pen_ungroup_shapes',
  'pen_align_shapes', 'pen_organize_layers', 'pen_apply_auto_layout',
  // Figma hierarchy
  'pen_reparent_shape', 'pen_set_constraints',
  // Components (legacy)
  'pen_create_component', 'pen_instantiate_component',
  // Component System (Phase 2 — Figma-aligned)
  'pen_convert_to_component', 'pen_place_component_instance',
  'pen_override_instance', 'pen_reset_instance',
  'pen_detach_instance', 'pen_combine_as_variants', 'pen_swap_variant',
  // Agentic Workflows (Phase 3 — emerging patterns: reflection, memory, RAG)
  'pen_self_critique', 'pen_recommend_components',
  'pen_search_design_patterns', 'pen_save_design_pattern',
  'pen_clear_pattern_memory', 'pen_pattern_stats',
  // Tokens / palette
  'pen_update_tokens', 'pen_apply_palette', 'pen_generate_palette',
  // Generators
  'pen_generate_design_brief', 'pen_generate_wireframe', 'pen_generate_user_flow', 'pen_generate_diagram',
  // Analysis
  'pen_generate_copy', 'pen_audit_design',
  // Token binding
  'pen_bind_shape_to_token', 'pen_unbind_shape', 'pen_list_tokens', 'pen_apply_token',
  // .pen-aligned tools (variables, themes, refs, slots, export)
  'pen_set_variable', 'pen_apply_theme', 'pen_create_ref', 'pen_override_descendant',
  'pen_mark_slot', 'pen_export_pen', 'pen_set_theme_axis', 'pen_list_themes',
  // Lock & visibility
  'pen_set_locked', 'pen_set_visible',
  // Z-order
  'pen_bring_to_front', 'pen_send_to_back', 'pen_move_forward', 'pen_move_backward',
  'pen_reorder_shape',
  // Undo / redo
  'pen_undo', 'pen_redo',
  // Export
  'pen_export_json', 'pen_export_svg', 'pen_export_png', 'pen_copy_as_code',
  // Find & filter
  'pen_find_shapes', 'pen_bulk_update_by_filter', 'pen_find_replace_text',
  // Vector
  'pen_create_path', 'pen_boolean_op', 'pen_mask_with',
  // Effects
  'pen_set_gradient_fill', 'pen_set_shadow', 'pen_set_blur',
  'pen_set_corner_radius_per_corner',
  // Images
  'pen_upload_image', 'pen_search_icons', 'pen_generate_image',
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
