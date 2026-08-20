# Components & Design Systems — Design Doc (Phase 2)

> **Status**: Implemented (2026-08-20)
> **Spec source**: Figma official docs + LogRocket UX article + UI Prep Variants 101
> **Code touchpoints**: `src/lib/canvas/{types,patch}.ts`, `src/lib/pen/{types,document,resolve}.ts`, `src/lib/agent/tools.ts`, `src/components/canvas/{PropertiesPanel,LayersPanel}.tsx`
> **Test coverage**: `tests/unit/component-system.test.ts` (15 tests)

---

## 1. Background — how Figma does it

### 1.1 Core concepts (from research)

| Concept | Figma behavior |
|---|---|
| **Main Component** | A reusable master definition (like a class). Has its own layer tree, properties, and styling. Lives in a library file for cross-file reuse. |
| **Instance** | A copy of the main component placed in a design. Inherits the master's structure + properties. Can be locally overridden. |
| **Component Set** | A container holding multiple main components that are variants of each other (e.g. Button → Size=L/State=Default, Size=L/State=Hover). Named via "Property=Value" forward-slash convention. |
| **Component Properties** | 4 types: Boolean (visibility), Text (content), Instance swap (nested component), Variant (axis picker). Slot property (Config 2023) is a placeholder for arbitrary content. |
| **Overrides** | Per-instance local changes: text content + typography, fill + stroke, shadow + blur effects, layout guides, nested instance swaps, child layer visibility. |
| **Library** | A Figma file published as a library containing all main components. Other files consume the library. Library updates propagate to consumers. |

### 1.2 Key Figma behaviors we replicate

| Figma behavior | AgentCanvas implementation |
|---|---|
| Create main component | `convert_to_component` patch op (frame/group → Component node, `reusable=true`) |
| Place instance | `place_instance` patch op (creates a proper `PenRef` pointing at the component) |
| Override instance property | `set_instance_override` patch op (sets `ref.descendants[path]`) |
| Reset overrides | `reset_instance` patch op (clears `descendants` + `componentProperties`) |
| Detach instance | `detach_instance` patch op (bakes the resolved tree into a standalone node) |
| Combine as variants | `combine_as_variants` patch op (wraps components into a `ComponentSet`) |
| Switch variant | `swap_variant` patch op (changes `ref.ref` to a different component) |
| Main→instance propagation | Automatic — every mutation triggers `resolvePenTree()` which re-expands all refs |

---

## 2. Architecture — how it fits into AgentCanvas

### 2.1 Subsystem touchpoints

```
┌─────────────────────────────────────────────────────────────────┐
│                            LLM / Agent                           │
│                                                                  │
│   7 new tools (src/lib/agent/tools.ts):                          │
│   • pen_convert_to_component                                     │
│   • pen_place_component_instance                                 │
│   • pen_override_instance                                        │
│   • pen_reset_instance                                           │
│   • pen_detach_instance                                          │
│   • pen_combine_as_variants                                      │
│   • pen_swap_variant                                             │
└──────────────────────┬──────────────────────────────────────────┘
                       │ CanvasPatch
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│              src/lib/canvas/patch.ts                            │
│                                                                 │
│   7 new patch ops:                                              │
│   • convert_to_component (→ updateNode)                          │
│   • place_instance (→ insert new PenRef)                        │
│   • set_instance_override (→ updateNode with normalized desc)   │
│   • reset_instance (→ updateNode, clear descendants)            │
│   • detach_instance (→ expandRef + replaceNodeInTree)           │
│   • combine_as_variants (→ removeFromTree + insert ComponentSet)│
│   • swap_variant (→ updateNode, change ref.ref)                │
│                                                                 │
│   Helpers: normalizeOverride (maps Shape → .pen field names),  │
│            replaceNodeInTree, removeFromTree, deriveVariantAxes │
└──────────────────────┬──────────────────────────────────────────┘
                       │ mutates doc.children
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│              src/lib/pen/document.ts (helpers)                  │
│                                                                 │
│   • expandRef(ref, components) — clones component + applies    │
│     descendant overrides. Tags each cloned node with           │
│     _sourceId so overrides can locate descendants post-clone.  │
│   • deepCloneNode — recurses into ALL container types          │
│     (frame/group/component/component_set/section/boolean_op)   │
│   • walkTree / findNode / findNodeArray / removeNode — fixed   │
│     to descend into all container types (was only frame/group) │
│   • collectComponents — gathers all reusable=true nodes        │
│   • isContainer() — shared type guard                           │
└──────────────────────┬──────────────────────────────────────────┘
                       │ expandRef
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│              src/lib/pen/resolve.ts                             │
│                                                                 │
│   resolvePenTree() calls expandTree() which replaces every      │
│   PenRef with its expanded subtree (via expandRef). Then       │
│   computes absolute positions + sizes + resolves $variables.   │
│                                                                 │
│   Result: doc.shapes (flat list for SVG rendering).              │
└──────────────────────┬──────────────────────────────────────────┘
                       │ doc.shapes
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│              React UI (src/components/canvas/)                  │
│                                                                 │
│   • PropertiesPanel — shows "Component instance (ref)" info    │
│     box with Detach + Reset overrides buttons when selected.   │
│   • LayersPanel — context menu: "Create component" (uses new   │
│     convert_to_component op for frames/groups), "Detach        │
│     instance", "Reset overrides" (when shape is an instance).  │
│   • Canvas — renders the resolved tree; instances show with    │
│     a ref badge + the main component's subtree.                 │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Data model (already in `src/lib/pen/types.ts`)

The PenRef type is the core instance node:

```ts
interface PenRef extends PenEntity {
  type: 'ref';
  ref: string;                     // id of the source (reusable) component
  descendants?: {                  // per-instance overrides keyed by source-id path
    [idPath: string]: Partial<PenChild>;
  };
  componentProperties?: PenComponentPropertyValues;
}
```

The PenComponent type defines component properties (Boolean / Text / Instance swap / Variant / Slot):

```ts
interface PenComponent extends PenRectangleish, PenCanHaveChildren, PenLayout {
  type: 'component';
  componentPropertyDefinitions?: PenComponentPropertyDefinitions;
  slot?: false | string[];
}
```

The PenComponentSet type holds variants:

```ts
interface PenComponentSet extends PenRectangleish, PenCanHaveChildren, PenLayout {
  type: 'component_set';
  variantPropertyAxes?: string[];                // ['Size', 'State']
  variantLayout?: 'horizontal' | 'vertical' | 'grid';
}
```

---

## 3. Implementation details

### 3.1 The `_sourceId` mechanism

When `expandRef` clones a component, every cloned node gets a `_sourceId` field set to its original id. This lets `applyDescendants` locate the right descendant to override even after the clone assigns fresh UUIDs.

```ts
// in deepCloneNode
(clone as { _sourceId?: string })._sourceId = node.id;
```

```ts
// in applyDescendants → findBySourcePath
if ((root as { _sourceId?: string })._sourceId === head) {
  // descend into children looking for the next segment
}
```

### 3.2 Field-name normalization

The agent tools accept Figma-style field names (`text`, `textColor`, `strokeWidth`, `radius`) but the .pen spec uses different names (`content`, `fill`, `strokeWeight`, `cornerRadius`). The `normalizeOverride()` helper in `patch.ts` does the mapping before storing on `ref.descendants[path]`:

| Figma / Shape name | .pen name | Why |
|---|---|---|
| `text` | `content` | .pen text nodes use `content` for text content |
| `textColor` | `fill` | .pen text nodes use `fill` for text color (same field as shape fill — node type disambiguates) |
| `strokeWidth` | `strokeWeight` | .pen uses `strokeWeight` (no camelCase) |
| `radius` | `cornerRadius` | .pen uses `cornerRadius` |

### 3.3 Container-type fix

A critical bug was discovered and fixed during implementation: `walkTree`, `findNode`, `findNodeArray`, `removeNode`, `insertNode`, `isDescendant`, and `deepCloneNode` all only descended into `frame` and `group` children. They didn't recurse into `component`, `component_set`, `section`, or `boolean_operation` containers.

This caused:
- `collectComponents` couldn't find components nested inside a `component_set` (variants)
- `expandRef` couldn't clone a component's children (they were dropped)
- `findBySourcePath` couldn't locate a descendant inside a `component`

The fix: introduced a shared `isContainer()` type guard and updated all 7 tree-walking functions to use it.

### 3.4 Preserving instance id on expand

The original `expandRef` deleted the ref's id from `rootOverride` so the clone's new id won. This broke selection (the user's selected instance id didn't match the resolved shape's id). The fix: keep the ref's id on the clone root, so the resolved tree's root matches what the user placed. Descendants still get fresh ids (tagged with `_sourceId`).

---

## 4. Test coverage

`tests/unit/component-system.test.ts` — 15 tests covering:

| Test | Description |
|---|---|
| `convert_to_component` | Promotes a frame into a reusable Component; refuses to promote non-promotable types |
| `place_instance` | Creates a PenRef pointing at a reusable component |
| `set_instance_override` | Overrides text on a descendant; merges multiple overrides on the same path; silently no-ops on non-ref nodes; end-to-end check that the resolved tree has the overridden text |
| `reset_instance` | Clears all overrides on an instance |
| `detach_instance` | Converts a PenRef into a standalone frame (link broken) |
| `combine_as_variants` | Wraps 2 components into a component_set with auto-derived axes; uses explicitly provided axes; refuses to combine when one id isn't a component |
| `swap_variant` | Switches which variant the instance points to |
| `main → instance propagation` | Updating the main component re-resolves instances automatically |
| `deriveVariantAxes` | Parses "Property=Value, Property=Value" naming convention; falls back to ['Variant'] for non-conforming names |

Run: `bun run test -- tests/unit/component-system.test.ts`

---

## 5. Usage examples

### 5.1 Agent prompt: "Design a button and use it 3 times with different labels"

```
User: Design a primary button and place 3 instances with text "Save", "Cancel", "Delete".

Agent plan:
1. pen_create_shape (frame: 140x40, fill #0ea5e9, radius 6)        → btn-frame
2. pen_create_shape (text: "Button", parentId: btn-frame)           → btn-label
3. pen_convert_to_component (shapeId: btn-frame)                   → btn-frame is now reusable
4. pen_place_component_instance (componentId: btn-frame, x: 300)  → inst-1
5. pen_override_instance (instanceId: inst-1, path: btn-label, text: "Save")
6. pen_place_component_instance (componentId: btn-frame, x: 500)  → inst-2
7. pen_override_instance (instanceId: inst-2, path: btn-label, text: "Cancel")
8. pen_place_component_instance (componentId: btn-frame, x: 700)  → inst-3
9. pen_override_instance (instanceId: inst-3, path: btn-label, text: "Delete")
```

### 5.2 Agent prompt: "Make a Button with Default + Hover variants"

```
User: Design a Button component with two variants: State=Default and State=Hover.

Agent plan:
1. pen_create_shape (frame: 100x40, fill #0ea5e9) → btn-default
   pen_update_shape (shapeId: btn-default, name: "State=Default, Size=Large")
2. pen_create_shape (frame: 100x40, fill #0284c7) → btn-hover
   pen_update_shape (shapeId: btn-hover, name: "State=Hover, Size=Large")
3. pen_convert_to_component (shapeId: btn-default)
4. pen_convert_to_component (shapeId: btn-hover)
5. pen_combine_as_variants (componentIds: [btn-default, btn-hover], name: "Button")
   → Creates a ComponentSet "Button" with axes ['State', 'Size']
6. pen_place_component_instance (componentId: btn-default, x: 300)
   → Instance of the SET, currently showing the Default variant
7. pen_swap_variant (instanceId: inst-1, variantComponentId: btn-hover)
   → Now shows the Hover variant
```

### 5.3 UI: detaching an instance

1. Click an instance on the canvas.
2. Right panel → Design tab.
3. Click **Detach** in the "Component instance (ref)" info box.
4. The instance becomes a standalone frame (overrides baked in; future main-component changes won't propagate).

---

## 6. What's NOT yet implemented (future work)

- **Components panel (Assets panel)** — Figma's left-panel tab for browsing + drag-to-place components. Currently instances are placed via the agent only.
- **Variant picker in Properties panel** — when an instance is of a component_set, show a dropdown to switch variants (currently only the agent can swap variants via `pen_swap_variant`).
- **Component properties UI** — UI to define Boolean/Text/Instance-swap properties on a main component (currently only the agent can define these via `set_component_property`).
- **Slot property UI** — UI for marking frames as slots and choosing preferred child components.
- **Push instance changes to main** — Figma lets you push an instance's overrides back into the main component. Not yet implemented.
- **Library publishing** — Figma's "publish this file as a library" feature for cross-file reuse. Out of scope for the current single-file model.

---

## 7. References

- [Figma — Guide to components](https://help.figma.com/hc/en-us/articles/360038662654-Guide-to-components-in-Figma)
- [Figma — Create and use variants](https://help.figma.com/hc/en-us/articles/360056440594-Create-and-use-variants)
- [Figma — Explore component properties](https://help.figma.com/hc/en-us/articles/5579474826519-Explore-component-properties)
- [Figma — Apply changes to instances](https://help.figma.com/hc/en-us/articles/360039150733-Apply-changes-to-instances)
- [LogRocket — Using Figma's instance swap and other component properties](https://blog.logrocket.com/ux-design/using-component-properties-figma)
- [UI Prep — Figma Variants 101](https://www.uiprep.com/blog/figma-variants-101)
