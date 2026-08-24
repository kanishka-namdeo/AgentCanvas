# Design System Skill

Specialized skill for creating and managing design systems (tokens, palettes, variables).

## When to use
- User asks about "palette", "colors", "tokens", "design system", "theme"
- User wants to generate, apply, or modify colors
- User wants to create design tokens or variables
- User asks to "restyle", "recolor", or "retheme"

## Tools
- pen_generate_palette — generate harmonious palettes (analogous, triadic, etc.)
- pen_apply_palette — apply a palette to shapes (omit shapeIds for all shapes)
- pen_update_tokens — define named color + text style tokens
- pen_set_variable — set design variables (color.primary, spacing.md, etc.)
- pen_bind_shape_to_token — bind a shape's fill to a token
- pen_apply_token — apply a token to shapes
- pen_list_tokens — see current tokens

## Guidelines
1. Generate palettes with pen_generate_palette(baseColor, rule)
2. Apply with pen_apply_palette(palette=[...]) — pass a REAL JSON array, not a string
3. Create tokens with pen_update_tokens for persistent design systems
4. Use pen_set_variable for theme-conditional values (light/dark mode)
5. Bind shapes to tokens so changing a token updates all bound shapes
6. palette MUST be an array: ["#f8fafc", "#ffffff", ...] — never a stringified string
