# AgentCanvas Tool Descriptions — Round 2 Extraction (Task 5-b)

Extracted read-only while baseline2 eval runs. These are the exact, current LLM-visible
`description` strings (plus `promptSnippet` / `promptGuidelines` where present) for the
known overlap clusters. This is the raw material for Round 2 description refinement.

Note on line numbers: `tools.ts` = src/lib/agent/tools.ts, `pen-tools.ts` =
src/lib/agent/pen-tools.ts, `figma-tools.ts` = src/lib/agent/figma-tools.ts.

Exposure rule (runner-native.ts:409-416): the final LLM toolset = CORE_TOOL_NAMES (10 tools,
every skill) + active skill's allowedTools + secondary categories' allowedTools +
(PEN_TOOL_NAMES + FIGMA_TOOL_NAMES ride-along only when wireframe is active/secondary or
activeCategory === 'multi' — `includePenFileTools`, Audit 2-b T3) + plugin tools.
'multi' fallback exposes ALL_TOOL_NAMES (registry.ts:724-779, ~87 names).

---

## Cluster 1 — Color / Tokens / Fill (known overlap)

### pen_set_variable — pen-tools.ts:42 (wireframe allowlist registry.ts:191; plus PEN_TOOL_NAMES ride-along when wireframe active/secondary or multi)
- label: `Set .pen Variable`
- description (verbatim):
  > Create or update a pen.dev document variable. Variables are design tokens referenced via "$name" (e.g. "$color.background"). A variable can have a single value, or a list of theme-conditional values (e.g. one value for mode=light, another for mode=dark). Use this to build a design-token system that thematically adapts. Maps to .pen `variables`.
- promptSnippet: `Create/update a $variable (color/number/string/boolean), optionally theme-aware.`
- promptGuidelines:
  - Variable keys use dotted notation: "color.primary", "text.heading.size", "spacing.md".
  - For a theme-aware variable, pass `themedValues` (an array of {value, theme}).
  - The FIRST themed value is the default. The last matching theme wins at render time.
  - Colors are hex strings like "#0ea5e9". Numbers are plain JSON numbers.

### pen_set_variables — tools.ts:2489 (wireframe + styling skills)
- label: `Set Variables`
- description (verbatim):
  > Update the document's variables — named colors and text styles that nodes can bind to. When a variable changes, every node bound to it (via tokenBinding) is recolored automatically. Pass only the variables you want to add or change; existing ones are merged by key.
- promptSnippet: `Update variables (color palette, text styles).`
- promptGuidelines:
  - Variable keys use dotted paths: `bg.primary`, `accent`, `text.heading`, etc.
  - After updating variables, use pen_apply_palette to bind nodes to them.

### pen_apply_variable — tools.ts:3265 (wireframe + styling skills)
- label: `Apply Variable to Nodes`
- description (verbatim):
  > Apply a variable's value to one or more nodes. Optionally also bind the nodes to the variable (live link). This is the batch version of pen_bind_variable.
- promptSnippet: `Apply a variable value to multiple nodes at once.`

### pen_bind_variable — tools.ts:3170 (wireframe + styling skills)
- label: `Bind Variable`
- description (verbatim):
  > Bind a node property (fill, stroke, or textColor) to a named variable. When the variable's value changes, the bound property auto-updates. Use this after pen_set_variables or pen_apply_palette to create a live link.
- promptSnippet: `Bind a node property to a variable (live link).`
- promptGuidelines:
  - The variableId must match a key in the document's color variables. Call pen_list_variables to see available keys.
  - Binding fill: the node's fill is set to the variable value immediately and re-computed on variable changes.

### pen_apply_palette — tools.ts:2549 (wireframe + styling skills)
- label: `Apply Palette to Shapes`
- description (verbatim):
  > Recolor a set of shapes using a new palette. Each shape's fill is mapped to the closest color in the palette by perceptual distance (HSL). Useful for "re-skinning" an existing layout without rebuilding it. Optionally binds the shapes to design tokens (so future palette changes propagate automatically). If shapeIds is omitted, applies to ALL shapes on the canvas — use this for "recolor everything" requests.
- promptSnippet: `Recolor shapes by mapping to a new palette (nearest match). Omit shapeIds to recolor all.`

### pen_set_fill — DOES NOT EXIST
No tool named `pen_set_fill` (or any `set_fill`) exists anywhere in src/lib/agent/.
The actual fill-setting tools in this cluster:
- **pen_update_node** — tools.ts:1454 (CORE, always loaded). Description (verbatim):
  > Update one or more properties of an existing node. Only the fields you provide are changed; others stay the same. Use this to move, resize, recolor, or edit text. Returns the patched node.
  - promptSnippet: `Update properties of an existing node (position, size, fill, text, …).`
  - promptGuidelines (relevant): "To change text content, set `text`. To change color, set `fill` (hex like #ff0000)."
- **pen_set_gradient_fill** — tools.ts:4641 (wireframe + styling skills). Description (verbatim):
  > Set a linear or radial gradient fill on a shape. Overrides the solid `fill` color. Provide 2+ stops (offset 0..1, color hex). For linear, specify angle 0..360 (0=→, 90=↓, 180=←, 270=↑).
  - promptSnippet: `Apply a gradient fill to a shape.`

---

## Cluster 2 — Components / Instances (known overlap)

### pen_create_component — figma-tools.ts:193 (FIGMA_TOOL_NAMES ride-along when wireframe active/secondary or multi; in NO skill allowlist)
- label: `Create Component`
- description (verbatim):
  > Promote a frame (or create a new one) into a COMPONENT — a reusable design element. Once a component exists, you can create INSTANCES of it via pen_create_ref.
- promptSnippet: `Create a reusable COMPONENT.`

### pen_convert_to_component — tools.ts:2226 (wireframe skill only)
- label: `Convert to Component`
- description (verbatim):
  > Promote an existing frame, group, or shape into a reusable Component (Figma: ⌘⇧O). The selected node becomes the "main component" — its type changes from "frame" to "component", and `reusable=true` is set so future instances can reference it via `pen_place_component_instance`. Use this AFTER designing a UI element you want to reuse (button, card, header, etc.).
- promptSnippet: `Turn a frame into a reusable component.`
- promptGuidelines:
  - The selected shape should be a frame or group containing the component's visual elements.
  - After converting, place instances via `pen_place_component_instance` — do NOT duplicate the main component.
  - To create variants (e.g. Primary, Secondary, Disabled states), convert each variant into its own component first, then call `pen_combine_as_variants`.

### pen_place_component_instance — tools.ts:2261 (wireframe skill only)
- label: `Place Component Instance`
- description (verbatim):
  > Place a linked instance of a reusable Component at (x, y). Creates a proper PenRef node that references the main component. The instance inherits the main's full subtree and can be overridden locally (text, fill, stroke, child visibility) without affecting the main. When the main component changes, all instances update automatically.
- promptSnippet: `Place a linked instance of a reusable component.`
- promptGuidelines:
  - Requires the source to be a reusable Component (convert first via `pen_convert_to_component`).
  - The instance will inherit the main's width/height/fill/stroke — don't pass those here.
  - To customize an instance (e.g. different label text), follow with `pen_override_instance`.

### pen_instantiate_component — tools.ts:2151 (NO skill allowlist; only via 'multi' fallback / ALL_TOOL_NAMES)
- label: `Instantiate Component`
- description (verbatim):
  > DEPRECATED — prefer pen_place_component_instance (PenRef-linked, tracks main-component edits) or pen_create_ref (.pen-native ref with descendant overrides). This legacy tool SHALLOW-COPIES the component: the instance does NOT update when the main component changes. Create a linked instance of an existing component; the copy gets a new id + componentId pointing at the original.
- promptSnippet: `Place a linked instance of a component.`

### pen_create_ref — pen-tools.ts:235 (PEN_TOOL_NAMES ride-along when wireframe active/secondary or multi; in NO skill allowlist)
- label: `Create Component Instance (ref)`
- description (verbatim):
  > Create a pen.dev component INSTANCE — a `ref` node that reuses a reusable component (one marked with reusable:true / created via pen_create_component or pen_convert_to_component). The instance replicates the component tree but can override individual descendant properties via `descendants`. Maps to .pen `ref` + `descendants`.
- promptSnippet: `Instantiate a reusable component as a `ref`, with optional descendant overrides.`
- promptGuidelines:
  - First mark a shape as reusable via pen_convert_to_component (or pen_create_component).
  - Pass the componentId as `ref`. The instance inherits the component tree.
  - Use `descendants` to override properties: { "label": { "text": "Cancel" } }.
  - Descendant keys are slash-separated ID paths: "ok-button/label".
  - If a descendant override includes a `type`, the node is REPLACED entirely.

---

## Cluster 3 — Destructive (known overlap)

### pen_delete_nodes — tools.ts:1582 (CORE_TOOL_NAMES, always loaded in every skill)
- label: `Delete Nodes`
- description (verbatim):
  > Delete one or more nodes from the canvas by id. This is permanent for the current session.
- promptSnippet: `Delete nodes by id.`

### pen_clear — tools.ts:1634 (CORE_TOOL_NAMES, always loaded in every skill)
- label: `Clear Canvas`
- description (verbatim):
  > Remove every shape from the canvas. Use sparingly — this is destructive and cannot be undone in this demo.
- promptSnippet: `Wipe the canvas clean.`
