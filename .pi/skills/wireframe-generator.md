# Wireframe Generator Skill

Specialized skill for generating UI wireframes from natural-language descriptions.

## When to use
- User asks to "design", "build", "create", "make" a screen, page, or layout
- User wants a wireframe, mockup, or a prototype
- User describes a mobile or web screen

## Tools
- pen_generate_wireframe — use templates (mobile_login, mobile_dashboard, web_landing, etc.)
- pen_generate_user_flow — for multi-screen flows (onboarding, ecommerce, auth)
- pen_generate_diagram — for flowcharts and mindmaps
- pen_generate_copy — fill text shapes with realistic placeholder copy
- pen_apply_palette — apply a harmonious color scheme
- pen_get_metadata — check what was created + copy exact ids
- pen_update_node — refine individual shapes ({ nodeId, changes: {...} })

## Guidelines
1. Try pen_generate_wireframe FIRST if the request matches a template
2. For multi-screen flows, use pen_generate_user_flow (not multiple wireframe calls)
3. After generating, call pen_get_metadata to see the IDs
4. Apply a palette with pen_apply_palette (omit shapeIds to recolor all)
5. Fill text with pen_generate_copy (pass shapeId as a plain string, not array)
6. Keep tool calls under 12 — prefer pen_create_subtree (one call, whole tree) and
   pen_bulk_update_by_filter (one call, many shapes) over per-node calls
7. If the user specifies colors, use those; otherwise default to the Slate palette

## Templates available
- mobile: mobile_login, mobile_signup, mobile_dashboard, mobile_welcome, mobile_permissions, mobile_done
- mobile commerce: mobile_browse, mobile_product_detail, mobile_cart, mobile_checkout
- web: web_landing, web_dashboard, web_blog, web_pricing

## Flows available
- onboarding: welcome → permissions → done (3 screens)
- ecommerce: browse → product → cart → checkout (4 screens)
- auth: login → mfa → home (3 screens)
- signup_funnel: landing → signup → verify → dashboard (4 screens)
