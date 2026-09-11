# Reusable Elements UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add visual editors for variables/tokens and component properties to the Properties Panel, allowing users to manage reusable elements without the agent.

**Architecture:** Enhance the existing Properties Panel with three new sections: (1) Token Editor in the empty state for managing variables, (2) Component Properties section when a Component is selected, (3) Instance Overrides section when an Instance is selected. All edits emit existing patch operations (`tokens`, `set_component_property`, `set_instance_property`) through the store.

**Tech Stack:** React, TypeScript, shadcn/ui components, Zustand store, .pen patch system

**Spec:** `docs/superpowers/specs/2026-09-12-reusable-elements-ui-design.md`

## Global Constraints

- All edits must be undoable (via existing undo/redo)
- All edits must broadcast to other viewers (via existing patch system)
- Use existing patch operations — no new ops required except `remove_variable`
- Follow existing code patterns in PropertiesPanel.tsx (inline JSX, memo, useCanvasStore)
- Use shadcn/ui components (Input, Button, Badge, Select, Dialog)
- Token names use dotted notation: `color.primary`, `spacing.md`
- Component property names use kebab-case: `show-icon`, `label-text`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/components/canvas/PropertiesPanel.tsx` | Add TokenEditor, ComponentPropertiesEditor, InstanceOverridesEditor sections |
| `src/lib/canvas/patch.ts` | Add `remove_variable` patch op handler |
| `src/lib/canvas/types.ts` | Add `remove_variable` to CanvasPatch op union |
| `tests/unit/reusable-elements-ui.test.ts` | Unit tests for token editor and component property UI |

---

### Task 1: Add `remove_variable` Patch Operation

**Files:**
- Modify: `src/lib/canvas/types.ts:387-529` (CanvasPatch type)
- Modify: `src/lib/canvas/patch.ts` (patch applier)
- Test: `tests/unit/reusable-elements-ui.test.ts`

**Interfaces:**
- Consumes: `CanvasDocument.variables` (existing)
- Produces: `remove_variable` patch op that deletes a variable by key

- [ ] **Step 1: Write failing test for remove_variable patch op**

Create `tests/unit/reusable-elements-ui.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import type { CanvasDocument, CanvasPatch } from '@/lib/canvas/types';

describe('remove_variable patch op', () => {
  it('removes a variable by key', () => {
    const doc: CanvasDocument = {
      id: 'test',
      name: 'Test',
      version: '2.17',
      children: [],
      viewport: { zoom: 1, panX: 0, panY: 0 },
      background: '#f8fafc',
      shapes: [],
      tokens: { colors: [{ name: 'color.primary', key: 'color.primary', value: '#0ea5e9' }], textStyles: [] },
      variables: {
        'color.primary': { type: 'color', value: '#0ea5e9' },
        'color.secondary': { type: 'color', value: '#8b5cf6' },
      },
    } as CanvasDocument;

    const patch: CanvasPatch = {
      op: 'remove_variable',
      variableKey: 'color.primary',
      summary: 'Removed variable color.primary',
    };

    const result = applyPatchToCanvas(doc, patch);
    expect(result.variables).toBeDefined();
    expect(result.variables!['color.primary']).toBeUndefined();
    expect(result.variables!['color.secondary']).toBeDefined();
  });

  it('is a no-op if variable does not exist', () => {
    const doc: CanvasDocument = {
      id: 'test',
      name: 'Test',
      version: '2.17',
      children: [],
      viewport: { zoom: 1, panX: 0, panY: 0 },
      background: '#f8fafc',
      shapes: [],
      tokens: { colors: [], textStyles: [] },
      variables: { 'color.primary': { type: 'color', value: '#0ea5e9' } },
    } as CanvasDocument;

    const patch: CanvasPatch = {
      op: 'remove_variable',
      variableKey: 'nonexistent',
      summary: 'Removed nonexistent',
    };

    const result = applyPatchToCanvas(doc, patch);
    expect(result.variables!['color.primary']).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test tests/unit/reusable-elements-ui.test.ts`
Expected: FAIL with "remove_variable" not recognized as a valid op

- [ ] **Step 3: Add `remove_variable` to CanvasPatch op union**

In `src/lib/canvas/types.ts`, find the `op:` union (around line 387-435) and add `'remove_variable'` to the list:

```typescript
export interface CanvasPatch {
  op:
    | 'add'
    | 'update'
    // ... existing ops ...
    | 'set_variable'
    | 'remove_variable'  // <-- ADD THIS LINE
    | 'mark_slot'
    // ... rest of ops ...
```

- [ ] **Step 4: Implement `remove_variable` patch handler in patch.ts**

In `src/lib/canvas/patch.ts`, find the `set_variable` case (search for `case 'set_variable':`) and add the `remove_variable` case immediately after:

```typescript
case 'remove_variable': {
  if (!patch.variableKey || !next.variables) break;
  const key = patch.variableKey;
  const { [key]: _, ...rest } = next.variables;
  next.variables = rest;
  // Recompute derived tokens
  const derived = variablesToTokens(next.variables);
  next.tokens = derived;
  break;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test tests/unit/reusable-elements-ui.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/canvas/types.ts src/lib/canvas/patch.ts tests/unit/reusable-elements-ui.test.ts
git commit -m "feat(patch): add remove_variable patch op for token deletion"
```

---

### Task 2: Token Editor UI — Add Variable Dialog

**Files:**
- Modify: `src/components/canvas/PropertiesPanel.tsx:294-319` (Variables section)
- Test: `tests/unit/reusable-elements-ui.test.ts`

**Interfaces:**
- Consumes: `document.tokens.colors`, `document.variables`, `sendPatch`
- Produces: "Add Variable" button + dialog for creating new tokens

- [ ] **Step 1: Write failing test for token editor state**

Add to `tests/unit/reusable-elements-ui.test.ts`:

```typescript
import { render, screen, fireEvent } from '@testing-library/react';
import { PropertiesPanel } from '@/components/canvas/PropertiesPanel';
import { useCanvasStore } from '@/lib/canvas/store';

describe('Token Editor UI', () => {
  it('renders Add Variable button in empty state', () => {
    // Setup store with empty tokens
    useCanvasStore.setState({
      document: {
        id: 'test',
        name: 'Test',
        version: '2.17',
        children: [],
        viewport: { zoom: 1, panX: 0, panY: 0 },
        background: '#f8fafc',
        shapes: [],
        tokens: { colors: [], textStyles: [] },
      },
      selectedIds: [],
    });

    render(<PropertiesPanel />);
    expect(screen.getByText(/Add Variable/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test tests/unit/reusable-elements-ui.test.ts`
Expected: FAIL — "Add Variable" button not found

- [ ] **Step 3: Add "Add Variable" button and dialog to PropertiesPanel**

In `src/components/canvas/PropertiesPanel.tsx`, find the Variables section (around line 294-319) and replace it with:

```typescript
{/* Variables panel with editor */}
<div>
  <div className="flex items-center gap-1.5 mb-2">
    <Palette className="h-3 w-3 ac-text-4" />
    <Label className="text-[11px] ac-text-3">Variables</Label>
    <span className="text-[10px] ac-text-4 ml-auto">{(document.tokens?.colors ?? []).length} color(s)</span>
  </div>
  {(document.tokens?.colors ?? []).length === 0 ? (
    <div className="text-[10px] ac-text-4 px-2 py-3 border border-dashed ac-border-subtle rounded text-center space-y-2">
      <p>No variables yet.</p>
      <Button
        variant="outline"
        size="sm"
        className="h-6 text-[10px]"
        onClick={() => setAddVariableOpen(true)}
      >
        + Add Variable
      </Button>
    </div>
  ) : (
    <div className="space-y-1">
      {(document.tokens?.colors ?? []).map((c) => (
        <div key={c.key} className="flex items-center gap-2 text-[10px] group">
          <div
            className="w-4 h-4 rounded border ac-border-default flex-shrink-0"
            style={{ background: c.value }}
          />
          <span className="ac-text-2 font-mono">{c.key}</span>
          <span className="ac-text-4 ml-auto font-mono">{c.value}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-4 w-4 p-0 opacity-0 group-hover:opacity-100"
            onClick={() => {
              sendPatch({
                op: 'remove_variable',
                variableKey: c.key,
                summary: `Removed variable ${c.key}`,
              });
              toast.success(`Removed $${c.key}`);
            }}
          >
            ×
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="h-6 text-[10px] w-full mt-2"
        onClick={() => setAddVariableOpen(true)}
      >
        + Add Variable
      </Button>
    </div>
  )}
</div>
```

Add state for the dialog at the top of the component (after line 132):

```typescript
const [addVariableOpen, setAddVariableOpen] = useState(false);
const [newVariableName, setNewVariableName] = useState('');
const [newVariableType, setNewVariableType] = useState<'color' | 'number' | 'string'>('color');
const [newVariableValue, setNewVariableValue] = useState('');
```

Add the dialog JSX at the end of the component (before the final `</div>`):

```typescript
{/* Add Variable Dialog */}
{addVariableOpen && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
    <div className="bg-white dark:bg-slate-900 rounded-lg shadow-lg p-4 w-80 space-y-3">
      <h3 className="text-sm font-semibold">Add Variable</h3>
      <div className="space-y-2">
        <div>
          <Label className="text-[11px]">Name</Label>
          <Input
            value={newVariableName}
            onChange={(e) => setNewVariableName(e.target.value)}
            placeholder="color.primary"
            className="h-7 text-xs mt-1"
          />
        </div>
        <div>
          <Label className="text-[11px]">Type</Label>
          <Select value={newVariableType} onValueChange={(v) => setNewVariableType(v as any)}>
            <SelectTrigger className="h-7 text-xs mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="color">Color</SelectItem>
              <SelectItem value="number">Number</SelectItem>
              <SelectItem value="string">String</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-[11px]">Value</Label>
          {newVariableType === 'color' ? (
            <input
              type="color"
              value={newVariableValue || '#0ea5e9'}
              onChange={(e) => setNewVariableValue(e.target.value)}
              className="h-7 w-full rounded border ac-border-default cursor-pointer mt-1"
            />
          ) : (
            <Input
              value={newVariableValue}
              onChange={(e) => setNewVariableValue(e.target.value)}
              placeholder={newVariableType === 'number' ? '16' : 'value'}
              className="h-7 text-xs mt-1"
            />
          )}
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => setAddVariableOpen(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!newVariableName || !newVariableValue}
          onClick={() => {
            const key = newVariableName.startsWith('$') ? newVariableName.slice(1) : newVariableName;
            sendPatch({
              op: 'tokens',
              tokens: {
                colors: [
                  ...(document.tokens?.colors ?? []),
                  { name: key, key, value: newVariableValue },
                ],
              },
              summary: `Added variable $${key}`,
            });
            setAddVariableOpen(false);
            setNewVariableName('');
            setNewVariableValue('');
            toast.success(`Added $${key}`);
          }}
        >
          Add
        </Button>
      </div>
    </div>
  </div>
)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test tests/unit/reusable-elements-ui.test.ts`
Expected: PASS

- [ ] **Step 5: Manual verification**

1. Open the app
2. Verify "Add Variable" button appears in empty state
3. Click button, verify dialog opens
4. Fill in name, type, value
5. Click Add, verify variable appears in list
6. Hover over variable, verify delete button appears
7. Click delete, verify variable is removed

- [ ] **Step 6: Commit**

```bash
git add src/components/canvas/PropertiesPanel.tsx tests/unit/reusable-elements-ui.test.ts
git commit -m "feat(ui): add token editor with add/delete variable UI"
```

---

### Task 3: Component Properties UI

**Files:**
- Modify: `src/components/canvas/PropertiesPanel.tsx` (after Name section)
- Test: `tests/unit/reusable-elements-ui.test.ts`

**Interfaces:**
- Consumes: `shape.componentPropertyDefinitions` (on component nodes)
- Produces: Component Properties section with "Add Property" button

- [ ] **Step 1: Write failing test for component properties section**

Add to `tests/unit/reusable-elements-ui.test.ts`:

```typescript
describe('Component Properties UI', () => {
  it('renders Component Properties section when component is selected', () => {
    useCanvasStore.setState({
      document: {
        id: 'test',
        name: 'Test',
        version: '2.17',
        children: [
          {
            id: 'comp1',
            type: 'component',
            name: 'Button',
            reusable: true,
            componentPropertyDefinitions: {
              'show-icon': { type: 'boolean', defaultValue: true },
              'label-text': { type: 'text', defaultValue: 'Submit' },
            },
          },
        ],
        viewport: { zoom: 1, panX: 0, panY: 0 },
        background: '#f8fafc',
        shapes: [
          { id: 'comp1', type: 'component', name: 'Button', componentId: 'comp1' },
        ],
        tokens: { colors: [], textStyles: [] },
      },
      selectedIds: ['comp1'],
    });

    render(<PropertiesPanel />);
    expect(screen.getByText(/Component Properties/i)).toBeInTheDocument();
    expect(screen.getByText(/show-icon/i)).toBeInTheDocument();
    expect(screen.getByText(/label-text/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test tests/unit/reusable-elements-ui.test.ts`
Expected: FAIL — "Component Properties" section not found

- [ ] **Step 3: Add Component Properties section to PropertiesPanel**

In `src/components/canvas/PropertiesPanel.tsx`, find the Name section (around line 427-438) and add the Component Properties section immediately after:

```typescript
{/* Component Properties section (when component is selected) */}
{shape.type === 'component' && (
  <div>
    <div className="flex items-center gap-1.5 mb-2">
      <Component className="h-3 w-3 ac-text-4" />
      <Label className="text-[11px] ac-text-3">Component Properties</Label>
    </div>
    {(() => {
      const props = (shape as any).componentPropertyDefinitions ?? {};
      const entries = Object.entries(props);
      if (entries.length === 0) {
        return (
          <div className="text-[10px] ac-text-4 px-2 py-2 border border-dashed ac-border-subtle rounded text-center">
            No properties defined.
          </div>
        );
      }
      return (
        <div className="space-y-1">
          {entries.map(([name, def]) => {
            const d = def as any;
            return (
              <div key={name} className="flex items-center gap-2 text-[10px]">
                <span className="ac-text-2 font-mono">{name}</span>
                <Badge variant="outline" className="text-[9px] px-1 py-0">
                  {d.type}
                </Badge>
                <span className="ac-text-4 ml-auto">
                  {d.type === 'boolean' ? (d.defaultValue ? '✓' : '✗') : String(d.defaultValue)}
                </span>
              </div>
            );
          })}
        </div>
      );
    })()}
    <Button
      variant="outline"
      size="sm"
      className="h-6 text-[10px] w-full mt-2"
      onClick={() => setAddPropertyOpen(true)}
    >
      + Add Property
    </Button>
  </div>
)}
```

Add state for the Add Property dialog (after the token editor state):

```typescript
const [addPropertyOpen, setAddPropertyOpen] = useState(false);
const [newPropertyName, setNewPropertyName] = useState('');
const [newPropertyType, setNewPropertyType] = useState<'boolean' | 'text' | 'variant'>('text');
const [newPropertyDefault, setNewPropertyDefault] = useState<string | boolean>('');
const [newPropertyOptions, setNewPropertyOptions] = useState('');
```

Add the Add Property dialog at the end of the component (after the Add Variable dialog):

```typescript
{/* Add Property Dialog */}
{addPropertyOpen && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
    <div className="bg-white dark:bg-slate-900 rounded-lg shadow-lg p-4 w-80 space-y-3">
      <h3 className="text-sm font-semibold">Add Component Property</h3>
      <div className="space-y-2">
        <div>
          <Label className="text-[11px]">Name (kebab-case)</Label>
          <Input
            value={newPropertyName}
            onChange={(e) => setNewPropertyName(e.target.value)}
            placeholder="show-icon"
            className="h-7 text-xs mt-1"
          />
        </div>
        <div>
          <Label className="text-[11px]">Type</Label>
          <Select value={newPropertyType} onValueChange={(v) => setNewPropertyType(v as any)}>
            <SelectTrigger className="h-7 text-xs mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="boolean">Boolean</SelectItem>
              <SelectItem value="text">Text</SelectItem>
              <SelectItem value="variant">Variant</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-[11px]">Default Value</Label>
          {newPropertyType === 'boolean' ? (
            <div className="flex items-center gap-2 mt-1">
              <input
                type="checkbox"
                checked={newPropertyDefault === true}
                onChange={(e) => setNewPropertyDefault(e.target.checked)}
              />
              <span className="text-xs">Enabled</span>
            </div>
          ) : (
            <Input
              value={String(newPropertyDefault)}
              onChange={(e) => setNewPropertyDefault(e.target.value)}
              placeholder={newPropertyType === 'variant' ? 'default' : 'Submit'}
              className="h-7 text-xs mt-1"
            />
          )}
        </div>
        {newPropertyType === 'variant' && (
          <div>
            <Label className="text-[11px]">Variant Options (comma-separated)</Label>
            <Input
              value={newPropertyOptions}
              onChange={(e) => setNewPropertyOptions(e.target.value)}
              placeholder="default, hover, disabled"
              className="h-7 text-xs mt-1"
            />
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => setAddPropertyOpen(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!newPropertyName}
          onClick={() => {
            sendPatch({
              op: 'set_component_property',
              shapeId: shape.id,
              componentProperty: {
                name: newPropertyName,
                type: newPropertyType,
                defaultValue: newPropertyDefault,
                variantOptions: newPropertyType === 'variant' && newPropertyOptions
                  ? newPropertyOptions.split(',').map(s => s.trim())
                  : undefined,
              },
              summary: `Added property ${newPropertyName}`,
            });
            setAddPropertyOpen(false);
            setNewPropertyName('');
            setNewPropertyDefault('');
            setNewPropertyOptions('');
            toast.success(`Added property ${newPropertyName}`);
          }}
        >
          Add
        </Button>
      </div>
    </div>
  </div>
)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test tests/unit/reusable-elements-ui.test.ts`
Expected: PASS

- [ ] **Step 5: Manual verification**

1. Create a component (right-click frame → "Create component")
2. Select the component
3. Verify "Component Properties" section appears
4. Click "Add Property"
5. Fill in name, type, default value
6. Click Add, verify property appears in list

- [ ] **Step 6: Commit**

```bash
git add src/components/canvas/PropertiesPanel.tsx tests/unit/reusable-elements-ui.test.ts
git commit -m "feat(ui): add component properties section with add property UI"
```

---

### Task 4: Instance Overrides UI

**Files:**
- Modify: `src/components/canvas/PropertiesPanel.tsx` (after Component info section)
- Test: `tests/unit/reusable-elements-ui.test.ts`

**Interfaces:**
- Consumes: `shape.componentProperties` (on instance nodes), master's `componentPropertyDefinitions`
- Produces: Instance Overrides section showing overridden properties

- [ ] **Step 1: Write failing test for instance overrides section**

Add to `tests/unit/reusable-elements-ui.test.ts`:

```typescript
describe('Instance Overrides UI', () => {
  it('renders Instance Overrides section when instance is selected', () => {
    useCanvasStore.setState({
      document: {
        id: 'test',
        name: 'Test',
        version: '2.17',
        children: [
          {
            id: 'comp1',
            type: 'component',
            name: 'Button',
            reusable: true,
            componentPropertyDefinitions: {
              'label-text': { type: 'text', defaultValue: 'Submit' },
            },
          },
          {
            id: 'inst1',
            type: 'ref',
            name: 'Button instance',
            ref: 'comp1',
            componentId: 'comp1',
            componentProperties: { 'label-text': 'Cancel' },
          },
        ],
        viewport: { zoom: 1, panX: 0, panY: 0 },
        background: '#f8fafc',
        shapes: [
          { id: 'comp1', type: 'component', name: 'Button', componentId: 'comp1' },
          { id: 'inst1', type: 'instance', name: 'Button instance', componentId: 'comp1' },
        ],
        tokens: { colors: [], textStyles: [] },
      },
      selectedIds: ['inst1'],
    });

    render(<PropertiesPanel />);
    expect(screen.getByText(/Instance Overrides/i)).toBeInTheDocument();
    expect(screen.getByText(/label-text/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue(/Cancel/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test tests/unit/reusable-elements-ui.test.ts`
Expected: FAIL — "Instance Overrides" section not found

- [ ] **Step 3: Add Instance Overrides section to PropertiesPanel**

In `src/components/canvas/PropertiesPanel.tsx`, find the Component info section (search for "Master:" or "componentId") and add the Instance Overrides section immediately after:

```typescript
{/* Instance Overrides section (when instance is selected) */}
{isComponentInstance && (() => {
  const master = document.shapes.find(s => s.id === shape.componentId);
  const masterProps = (master as any)?.componentPropertyDefinitions ?? {};
  const instanceProps = (shape as any)?.componentProperties ?? {};
  const overrideEntries = Object.entries(instanceProps).filter(([name]) => name in masterProps);
  
  if (overrideEntries.length === 0 && Object.keys(masterProps).length === 0) {
    return null; // No properties defined on master
  }
  
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2">
        <Component className="h-3 w-3 ac-text-4" />
        <Label className="text-[11px] ac-text-3">Instance Overrides</Label>
      </div>
      <div className="space-y-2">
        {Object.entries(masterProps).map(([name, def]) => {
          const d = def as any;
          const overriddenValue = instanceProps[name];
          const isOverridden = overriddenValue !== undefined && overriddenValue !== d.defaultValue;
          
          return (
            <div key={name} className="flex items-center gap-2 text-[10px]">
              <span className="ac-text-2 font-mono">{name}</span>
              {d.type === 'boolean' ? (
                <input
                  type="checkbox"
                  checked={isOverridden ? overriddenValue === true : d.defaultValue === true}
                  onChange={(e) => {
                    sendPatch({
                      op: 'set_instance_property',
                      shapeId: shape.id,
                      instancePropertyName: name,
                      instancePropertyValue: e.target.checked,
                      summary: `Set ${name} = ${e.target.checked}`,
                    });
                  }}
                />
              ) : d.type === 'variant' && d.variantOptions ? (
                <Select
                  value={isOverridden ? String(overriddenValue) : String(d.defaultValue)}
                  onValueChange={(v) => {
                    sendPatch({
                      op: 'set_instance_property',
                      shapeId: shape.id,
                      instancePropertyName: name,
                      instancePropertyValue: v,
                      summary: `Set ${name} = ${v}`,
                    });
                  }}
                >
                  <SelectTrigger className="h-6 text-[10px] w-20">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {d.variantOptions.map((opt: string) => (
                      <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={isOverridden ? String(overriddenValue) : String(d.defaultValue)}
                  onChange={(e) => {
                    sendPatch({
                      op: 'set_instance_property',
                      shapeId: shape.id,
                      instancePropertyName: name,
                      instancePropertyValue: e.target.value,
                      summary: `Set ${name} = ${e.target.value}`,
                    });
                  }}
                  className="h-6 text-[10px] w-20"
                />
              )}
              {isOverridden && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-4 w-4 p-0 text-[10px]"
                  onClick={() => {
                    sendPatch({
                      op: 'set_instance_property',
                      shapeId: shape.id,
                      instancePropertyName: name,
                      instancePropertyValue: d.defaultValue,
                      summary: `Reset ${name} to default`,
                    });
                  }}
                >
                  ×
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
})()}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test tests/unit/reusable-elements-ui.test.ts`
Expected: PASS

- [ ] **Step 5: Manual verification**

1. Create a component with a property
2. Place an instance of the component
3. Select the instance
4. Verify "Instance Overrides" section appears
5. Change a property value
6. Verify the change is reflected
7. Click reset (×) to revert to default

- [ ] **Step 6: Commit**

```bash
git add src/components/canvas/PropertiesPanel.tsx tests/unit/reusable-elements-ui.test.ts
git commit -m "feat(ui): add instance overrides section for component instances"
```

---

### Task 5: Integration Tests and Documentation

**Files:**
- Modify: `tests/unit/reusable-elements-ui.test.ts`
- Modify: `src/components/canvas/AGENTS.md`

- [ ] **Step 1: Run all tests to verify nothing is broken**

Run: `bun run test`
Expected: All tests pass

- [ ] **Step 2: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Update AGENTS.md with new UI features**

In `src/components/canvas/AGENTS.md`, find the PropertiesPanel section and add:

```markdown
- **Token Editor** (empty state): Add/edit/delete variables/tokens. Dialog for creating new tokens with name, type (color/number/string), and value. Delete via hover button.
- **Component Properties** (component selected): View component property definitions. Add new properties (boolean/text/variant) via dialog.
- **Instance Overrides** (instance selected): View and edit property overrides on component instances. Type-aware inputs (checkbox for boolean, dropdown for variant, text input for text). Reset individual overrides to master default.
```

- [ ] **Step 4: Commit documentation update**

```bash
git add src/components/canvas/AGENTS.md
git commit -m "docs(canvas): document token editor and component property UI"
```

---

## Summary

This plan implements the two P0 blocker gaps identified in the reusable elements evaluation:

1. **Token Editor** — Users can now create, edit, and delete variables/tokens through the Properties Panel without the agent
2. **Component Property UI** — Users can view component properties and override them on instances through visual editors

**Total estimated implementation time:** 2-3 hours
**Files touched:** 4 files (~300 lines added)
**New patch ops:** 1 (`remove_variable`)
**New UI components:** 3 sections in PropertiesPanel (TokenEditor, ComponentProperties, InstanceOverrides)
