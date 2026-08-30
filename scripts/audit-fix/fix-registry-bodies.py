#!/usr/bin/env python3
"""Surgical edits to skills/registry.ts wireframe body (S10) + multi body (S9).

The template literals contain heavy escaping, so string surgery is done
between stable markers instead of full-literal matching.
"""
import re
import sys

PATH = '/home/z/my-project/src/lib/agent/skills/registry.ts'
src = open(PATH, encoding='utf-8').read()
orig = src

# ---- 1. Replace the wireframe STRATEGY block (S10) --------------------------
new_strategy = '''=== STRATEGY (audit 2-c S10 - aligned with the current architecture) ======

The system pre-generates a DESIGN BRIEF for every design turn and injects it into your prompt
("[PRE-GENERATED DESIGN BRIEF ...]"). It IS the palette / typography / layout source of truth -
do NOT call pen_generate_design_brief, do NOT hand-define tokens unless the brief is absent.

1. BUILD in as FEW calls as possible (aim <= 12 for the whole turn):
   - If a built-in template fits the request, ONE pen_generate_wireframe call produces a fully
     styled screen (shadows, gradients, radii, real content are baked in). Templates: mobile_login,
     mobile_signup, mobile_dashboard, mobile_welcome, mobile_permissions, mobile_done, mobile_browse,
     mobile_product_detail, mobile_cart, mobile_checkout, web_landing, web_dashboard, web_blog,
     web_pricing. Multi-screen flow (onboarding/ecommerce/auth/signup_funnel) -> pen_generate_user_flow.
     Diagram (flowchart/mindmap) -> pen_generate_diagram.
   - Otherwise build with 1-3 pen_create_subtree calls (whole nested trees; "nodes: [...]" for
     several INDEPENDENT trees at once; the result lists every generated id) or one pen_insert_html.
   - Repeating an element N times -> pen_duplicate_nodes { count, direction } - ONE call.
   - Emit independent tool calls in the SAME response (batched execution).
2. VERIFY: call pen_get_metadata once after building - check types, names, geometry, and any
   resolver warnings (fix container_overflow / unresolved $vars in the same turn).
3. RESTYLE in batches: pen_bulk_update_by_filter (filter + changes) beats N pen_update_node calls.
   One-off surgical changes -> pen_update_node { nodeId, changes: { ... } }.
4. CONTENT: replace placeholder text ("Lorem ipsum", "Item 1") with realistic domain copy via
   pen_find_replace_text or the text field of pen_update_node. Real names, real numbers, real labels.
   When the user gave exact copy, use those EXACT strings.
5. ICONS: lucide icon nodes via pen_search_icons (stroke width 2, size 20-24). NEVER emoji.
6. COMPONENTIZE (optional): 3+ similar shapes -> pen_recommend_components, then convert + place
   linked instances (pen_convert_to_component / pen_place_component_instance / pen_create_ref).
7. REPARHING: to move X into a frame, create the target frame with pen_create_node, THEN
   pen_reparent_nodes (keepAbsolutePosition default). Never pass "parent" to pen_update_node.

The system runs an AUTOMATIC critic pass (text critic + vision critic on the rendered canvas)
after your turn; if it finds defects you will be re-prompted with exact fix instructions. You do
NOT need to call pen_self_critique yourself during the turn - spend your calls on the design.

'''
m = re.search(r"=== STRATEGY \(follow this order.*?(?==== ARGUMENT RULES)", src, re.S)
if not m:
    print('FAIL: STRATEGY block not found'); sys.exit(1)
src = src[:m.start()] + new_strategy + src[m.end():]

# ---- 2. Placement line (P5 contradiction #3) --------------------------------
src = src.replace(
    'Place the first screen at (100, 100). Additional screens go at +475px (mobile) or +1380px (web).',
    'For placement, ALWAYS use the "Next screen placement" line at the end of the canvas snapshot -\nit gives the exact free coordinates for the next screen. On an empty canvas, place the first\nscreen frame at (200, 50).',
)

# ---- 3. Completion criteria + budget (P5 contradiction #2) ------------------
src = src.replace(
    '  The self-critique returned no outstanding [BLOCKER] findings.',
    '  pen_get_metadata shows no unresolved warnings on the new shapes.',
)
src = src.replace(
    'Budget ~15-25 tool calls for a proper high-fidelity screen.',
    'Budget <= 12 tool calls for the whole turn.',
)

# ---- 4. Multi skill body (S9) -----------------------------------------------
old_multi = '''export function formatSkillBodyForPrompt(category: SkillCategory): string {
  if (category === 'multi') {
    return ''; // No skill-specific body — all tools are available.
  }'''
new_multi = '''const MULTI_SKILL_BODY = `You have access to ALL canvas tools (no task-specific skill was matched,
or skill selection is in manual mode).

=== UNIVERSAL DISCIPLINE ===================================================

- Read before you write: pen_get_metadata (no args) lists the whole layer tree with ids - copy
  ids verbatim, never guess them.
- Build with pen_create_subtree (whole nested trees, "nodes: [...]" for several at once) instead
  of N pen_create_node calls; repeat elements with pen_duplicate_nodes { count, direction }.
- Restyle many layers at once with pen_bulk_update_by_filter - not one update per layer.
- Emit independent tool calls in the SAME response (batched, ordered execution).
- Aim for <= 12 tool calls per request.
- For a new design from scratch, follow the HIGH-FIDELITY rules in the system prompt (palette,
  shadows, gradients, real content, tokens, lucide icons - never emoji).
- On edit turns, REUSE the document's existing $variables - never redefine $color.* when the
  canvas already defines them.
- The system runs an automatic critic pass after your turn; fix instructions arrive as a
  re-prompt if defects are found.`;

export function formatSkillBodyForPrompt(category: SkillCategory): string {
  if (category === 'multi') {
    // Audit 2-c S9: the multi fallback used to get NO body at all - the
    // biggest tool list with the least guidance. It now gets a compact
    // generic body so the model still knows the batch-construction discipline.
    return `<active_skill id="multi">\\n${MULTI_SKILL_BODY}\\n</active_skill>`;
  }'''
if old_multi not in src:
    print('FAIL: multi body block not found'); sys.exit(1)
src = src.replace(old_multi, new_multi)

open(PATH, 'w', encoding='utf-8').write(src)
print('OK: registry.ts skill bodies updated',
      f'({len(orig)} -> {len(src)} bytes)')
