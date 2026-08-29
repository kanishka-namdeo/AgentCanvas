# Custom Design Audit Skill

A specialized skill for auditing design consistency, accessibility, and best practices.

## When to use
- User asks to "audit", "check", "review", or "analyze" the design
- User wants to find consistency issues (color, typography, spacing)
- User wants accessibility checks (contrast, font size)

## Tools
- pen_get_metadata — get the current canvas state (layer tree with ids)
- pen_audit_design — run the built-in audit checks
- pen_find_nodes — filter by type/color/name

## Guidelines
1. Always start with pen_get_metadata to see the current state
2. Run pen_audit_design for automated checks
3. Report findings grouped by severity (high/medium/low)
4. Suggest specific fixes with tool calls where possible
5. Check WCAG contrast ratios for text on backgrounds
6. Verify spacing consistency (8px grid)
7. Check that all colors come from the design system (tokens/variables)
