# Reusable Elements UI: Variable Editor + Component Property UI

**Date:** 2026-09-12
**Status:** Draft
**Author:** Agent + User brainstorm

## Problem Statement

AgentCanvas has a robust component system with 21 agent tools covering the full lifecycle of reusable elements (components, variants, instances, variables, tokens). However, two critical gaps prevent non-technical users from managing these elements without the agent:

1. **No visual variable/token editor** — Users cannot create, edit, or delete `$color.primary` style tokens through the UI. The Properties Panel shows a read-only list of tokens in its empty state, but there is no way to modify them.

2. **No component property UI** — Components can have properties defined (boolean, text, instance_swap, variant) via `pen_set_component_property`, but there is no visual interface to view or edit these properties. Similarly, instances cannot override properties visually.

These are P0 blockers because they lock users out of the design system. Without a way to manage tokens and properties visually, users must rely entirely on the agent for basic design system operations.

## Solution Overview

Add two visual editors to the Properties Panel:

1. **Token Editor** — Inline editing of document variables/tokens in the Properties Panel empty state
2. **Component Property UI** — View and edit component properties when a Component is selected; view and override properties when an Instance is selected

Both editors use existing patch operations and storage — no new data models required.

## Architecture

### 1. Token Editor

**Location:** Properties Panel empty state (when nothing is selected)

**Current State:**
```
┌─────────────────────────────────────┐
│  Canvas Background                  │
│  [color picker]                     │
│                                     │
│  Design Tokens                      │
│  • $color.primary: #0ea5e9          │
│  • $color.secondary: #8b5cf6        │
│  ...                                │
└─────────────────────────────────────┘
```

**New State:**
```
┌─────────────────────────────────────┐
│  Canvas Background                  │
│  [color picker]                     │
│                                     │
│  Design Tokens                      │
│  ┌─────────────────────────────┐   │
│  │ $color.primary    [#0ea5e9] │   │
│  │ $color.secondary  [#8b5cf6] │   │
│  │ $spacing.md       [16]      │   │
│  │ [+ Add Variable]            │   │
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
```

**Features:**
- **Inline editing** — Click token name to rename, click value to edit
- **Type-aware inputs** — Color picker for colors, number input for numbers, text input for strings, checkbox for booleans
- **Add variable** — Button opens dialog: name, type (color/number/string/boolean), initial value
- **Delete variable** — Right-click context menu or hover trash icon
- **Theme support** — Show mode-specific values (light/dark) with expandable rows (stretch goal)

**Data Flow:**
```
User edits token value
         │
         ▼
TokenEditor emits patch: { op: 'tokens', tokens: { colors: [...], textStyles: [...] } }
         │
         ▼
patch.ts applies to document.variables (via variablesToTokens)
         │
         ▼
recomputeDerived() re-resolves tree
         │
         ▼
All shapes using $color.primary update automatically
```

**Implementation Details:**
- Component: `TokenEditor` (inline in PropertiesPanel.tsx)
- State: Local state for editing mode (which token is being edited)
- Patch op: Reuse existing `tokens` op (already supports add/update)
- New patch op: `remove_variable` (delete a token by key)
- Storage: `document.variables` (existing) → `document.tokens` (derived cache)

**Edge Cases:**
- Token name collision — Show error toast, don't apply patch
- Token in use — Allow deletion, but warn that shapes using it will show unresolved variable
- Empty value — Don't allow empty values, show validation error

### 2. Component Property UI

**Location:** Properties Panel when a Component or Instance is selected

**Component Selected:**
```
┌─────────────────────────────────────┐
│  Name: [Primary Button]             │
│  Position: X [100] Y [200]          │
│  Size: W [120] H [40]               │
│                                     │
│  Component Properties               │
│  ┌─────────────────────────────┐   │
│  │ show-icon  [☑] boolean      │   │
│  │ label-text [Submit] text    │   │
│  │ size       [Large ▼] variant│   │
│  │ [+ Add Property]            │   │
│  └─────────────────────────────┘   │
│                                     │
│  Style: ...                         │
└─────────────────────────────────────┘
```

**Instance Selected:**
```
┌─────────────────────────────────────┐
│  Name: [Primary Button instance]    │
│  Master: Primary Button             │
│  [Detach] [Reset Overrides]         │
│                                     │
│  Instance Overrides                 │
│  ┌─────────────────────────────┐   │
│  │ label-text [Cancel]         │   │
│  │ show-icon  [ ]              │   │
│  │ size       [Small ▼]        │   │
│  └─────────────────────────────┘   │
│                                     │
│  Position: X [300] Y [200]          │
│  ...                                │
└─────────────────────────────────────┘
```

**Features:**
- **Component Properties section** — Shows all defined properties with type badges (boolean, text, instance_swap, variant)
- **Add Property button** — Dialog: name (kebab-case), type, default value, variant options (for variant type)
- **Instance Overrides section** — Shows only properties that differ from master defaults
- **Type-aware inputs:**
  - boolean → Checkbox
  - text → Text input
  - instance_swap → Dropdown of component IDs (from `preferredValues`)
  - variant → Dropdown of variant options (from `variantOptions`)
- **Reset individual override** — Hover X to revert to master default value
- **Delete property** — Right-click context menu on property row (component only)

**Data Flow (Add Property):**
```
User clicks "Add Property" on Component
         │
         ▼
Dialog: name, type, default value
         │
         ▼
ComponentPropertiesEditor emits patch:
{ op: 'set_component_property', shapeId: componentId, componentProperty: { name, type, defaultValue, variantOptions } }
         │
         ▼
patch.ts updates component.componentPropertyDefinitions
         │
         ▼
All instances now show the new property in their override panel (with default value)
```

**Data Flow (Instance Override):**
```
User changes property value on Instance
         │
         ▼
InstanceOverridesEditor emits patch:
{ op: 'set_instance_property', shapeId: instanceId, instancePropertyName: "label-text", instancePropertyValue: "Cancel" }
         │
         ▼
patch.ts updates ref.componentProperties
         │
         ▼
Resolver applies override during expandRef()
         │
         ▼
Instance renders with overridden value
```

**Implementation Details:**
- Components: `ComponentPropertiesEditor` and `InstanceOverridesEditor` (inline in PropertiesPanel.tsx)
- State: Local state for "Add Property" dialog
- Patch ops: Reuse existing `set_component_property` and `set_instance_property` ops
- Storage: `componentPropertyDefinitions` on component nodes, `componentProperties` on ref nodes

**Edge Cases:**
- Property name collision — Show error toast, don't apply patch
- Variant with no options — Show warning, require at least one option
- Instance override on non-existent property — Ignore (defensive)
- Component with no properties — Show empty state with "Add Property" button

## Files Touched

| File | Changes | Lines |
|------|---------|-------|
| `src/components/canvas/PropertiesPanel.tsx` | Add TokenEditor, ComponentPropertiesEditor, InstanceOverridesEditor sections | ~300 lines added |
| `src/lib/canvas/patch.ts` | Add `remove_variable` patch op | ~20 lines added |
| `src/lib/canvas/types.ts` | Add `remove_variable` to CanvasPatch union | ~5 lines added |

**No new files** — everything fits into existing infrastructure.

## Testing Strategy

### Unit Tests
- Token editor state management (add, edit, delete)
- Property type validation (boolean, text, instance_swap, variant)
- Patch op generation (tokens, set_component_property, set_instance_property, remove_variable)

### Integration Tests
- Token edit → shape update (verify all shapes using token update)
- Property add → instance override (verify new property appears in instance panel)
- Instance override → render (verify resolver applies override)

### Visual Tests
- Screenshot comparison of Properties Panel before/after
- Verify type-aware inputs render correctly (color picker, checkbox, dropdown)

## Scope Boundaries

### In Scope
- Variable/token visual editor (add, edit, delete)
- Component property UI (add property, view properties)
- Instance override UI (view overrides, reset individual override)
- Type-aware inputs (color picker, checkbox, text input, dropdown)
- Validation (name collision, empty values, variant options)

### Out of Scope
- Variant preview in Assets tab (P1)
- Component search in Assets tab (P2)
- Pattern memory UI (P2)
- Cross-document components (P1)
- Design-system pack creation API (P1)
- Theme mode switcher UI (stretch goal)
- Property drag-to-reorder (stretch goal)

## Success Criteria

1. Users can create a new token without the agent
2. Users can edit an existing token value and see all shapes update
3. Users can delete a token (with warning if in use)
4. Users can add a component property (boolean, text, variant)
5. Users can view all properties on a component
6. Users can override a property on an instance
7. Users can reset an individual override to master default
8. All operations are undoable (via existing undo/redo)
9. All operations broadcast to other viewers (via existing patch system)

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Token deletion breaks shapes | Show warning toast, allow undo |
| Property name collision | Validate before patch, show error |
| Instance override on missing property | Defensive check, ignore silently |
| Performance (many tokens) | Virtualize list if >50 tokens (stretch) |
| Accessibility (color picker) | Ensure keyboard navigation, ARIA labels |

## Future Enhancements (Not in This Spec)

- **Theme mode switcher** — Toggle between light/dark mode values
- **Token groups** — Organize tokens by category (color, spacing, typography)
- **Token search** — Filter tokens by name
- **Property drag-to-reorder** — Reorder properties in component panel
- **Variant preview** — Show all variants in Assets tab
- **Cross-document components** — Team library or document import

## References

- Existing component system: `src/lib/agent/tools.ts` (17 component tools)
- Existing patch ops: `src/lib/canvas/patch.ts` (lines 762-1008)
- Existing resolver: `src/lib/pen/resolve.ts` (expandRef, collectComponents)
- Existing Properties Panel: `src/components/canvas/PropertiesPanel.tsx`
- .pen schema: `src/lib/pen/types.ts` (PenComponent, PenRef, PenComponentPropertyDefinition)
