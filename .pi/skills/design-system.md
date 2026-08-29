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
- pen_set_variables — define named color + text style tokens (batch)
- pen_set_variable — set a single design variable (color.primary, spacing.md, etc.)
- pen_bind_variable — bind a shape's fill to a variable
- pen_apply_variable — apply a variable to shapes
- pen_list_variables — see current tokens

## Guidelines
1. Generate palettes with pen_generate_palette(baseColor, rule)
2. Apply with pen_apply_palette(palette=[...]) — pass a REAL JSON array, not a string
3. Create tokens with pen_set_variables for persistent design systems
4. Use pen_set_variable for theme-conditional values (light/dark mode)
5. Bind shapes to variables so changing a variable updates all bound shapes
6. palette MUST be an array: ["#f8fafc", "#ffffff", ...] — never a stringified string
