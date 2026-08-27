// Figma-aligned pi agent tools.
//
// These tools expose Figma-canonical concepts that the legacy pen_* surface
// doesn't fully capture. They're ADDITIVE — existing tools keep working.
//
// Tools added in the Figma ontology alignment:
//
//   1. figma_create_page           — add a new PAGE to the document
//   2. figma_set_active_page       — switch the active page (canvas swaps)
//   3. figma_rename_page            — rename a page
//   4. figma_delete_page            — delete a page (cannot delete the last)
//   5. figma_create_section         — create a SECTION node
//   6. figma_create_component       — promote a frame to a COMPONENT (reusable)
//   7. figma_create_component_set   — create a COMPONENT_SET container for variants
//   8. figma_add_variant            — add a variant COMPONENT to an existing component_set
//   9. figma_set_component_property — define a component property
//  10. figma_set_instance_property — override a component property on an instance

import { Type } from '@sinclair/typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { CanvasPatch } from '../canvas/types';
import type { CanvasToolContext } from './tools';

export function createFigmaTools(ctx: CanvasToolContext) {
  const createPage = defineTool({
    name: 'pen_create_page',
    label: 'Create Page',
    description:
      'Add a new PAGE to the document. Pages are top-level canvas surfaces within a file — ' +
      'create one ONLY when the user explicitly asks for a separate page ("put this on a new page"). ' +
      'By default, keep multiple screens as side-by-side top-level frames on the CURRENT page — ' +
      'a new page swaps the canvas away from what the user is looking at, hiding their work. ' +
      'The new page becomes active after creation.',
    promptSnippet: 'Add a new page to the document.',
    promptGuidelines: [
      'Create a page only on explicit user request — most multi-screen designs belong as side-by-side top-level frames on ONE page.',
      'Give the page a descriptive name: "Home", "Sign up flow", "Dashboard v2".',
    ],
    parameters: Type.Object({
      name: Type.String({
        description: 'Display name for the new page. E.g. "Home", "Dashboard", "Mobile flows".',
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const patch: CanvasPatch = {
        op: 'add_page',
        pageName: params.name,
        summary: `Created page "${params.name}"`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{
          type: 'text',
          text: `Created page "${params.name}". It is now the active page — the canvas has swapped to its empty layer tree.`,
        }],
        // `patch` MUST ride in details: the agent-session translator extracts
        // patches from tool results (details.patch / details.patches) and
        // streams them to every viewer + the WS twin. ctx.applyPatch only
        // updates the runner-LOCAL canvas — without this field the page op
        // silently desyncs every other canvas (the multi-screen overlap bug).
        details: { patch, pageName: params.name },
      };
    },
  });

  const setActivePage = defineTool({
    name: 'pen_set_active_page',
    label: 'Switch Active Page',
    description:
      'Switch the active page. The canvas swaps to the target page\'s layer tree + viewport.',
    promptSnippet: 'Switch the active page.',
    parameters: Type.Object({
      pageName: Type.Optional(Type.String({
        description: 'Name of the page to activate (case-insensitive, partial match accepted).',
      })),
      pageId: Type.Optional(Type.String({
        description: 'ID of the page to activate (alternative to pageName).',
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const patch: CanvasPatch = {
        op: 'set_active_page',
        pageId: params.pageId,
        pageName: params.pageName,
        summary: `Switched active page to "${params.pageName ?? params.pageId}"`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{
          type: 'text',
          text: `Switched active page to "${params.pageName ?? params.pageId}".`,
        }],
        details: { patch, pageId: params.pageId, pageName: params.pageName },
      };
    },
  });

  const renamePage = defineTool({
    name: 'pen_rename_page',
    label: 'Rename Page',
    description: 'Rename an existing page. Identify it by id or by current name.',
    promptSnippet: 'Rename a page.',
    parameters: Type.Object({
      pageId: Type.Optional(Type.String({ description: 'ID of the page to rename.' })),
      currentPageName: Type.Optional(Type.String({
        description: 'Current name of the page (alternative to pageId).',
      })),
      newName: Type.String({ description: 'New name for the page.' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const patch: CanvasPatch = {
        op: 'rename_page',
        pageId: params.pageId,
        pageName: params.newName,
        summary: `Renamed page to "${params.newName}"`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Renamed page to "${params.newName}".` }],
        details: { patch, pageId: params.pageId, newName: params.newName },
      };
    },
  });

  const deletePage = defineTool({
    name: 'pen_delete_page',
    label: 'Delete Page',
    description:
      'Delete a page from the document. The page\'s layer tree is permanently removed. ' +
      'Cannot delete the last remaining page.',
    promptSnippet: 'Delete a page (cannot delete the last one).',
    parameters: Type.Object({
      pageId: Type.Optional(Type.String({ description: 'ID of the page to delete.' })),
      pageName: Type.Optional(Type.String({
        description: 'Name of the page to delete (alternative to pageId).',
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const patch: CanvasPatch = {
        op: 'delete_page',
        pageId: params.pageId,
        pageName: params.pageName,
        summary: `Deleted page "${params.pageName ?? params.pageId}"`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Deleted page "${params.pageName ?? params.pageId}".` }],
        details: { patch, pageId: params.pageId, pageName: params.pageName },
      };
    },
  });

  const createSection = defineTool({
    name: 'pen_create_section',
    label: 'Create Section',
    description:
      'Create a SECTION node — Figma\'s large grouping container with a header label. ' +
      'Use sections to organize areas of the canvas.',
    promptSnippet: 'Create a SECTION (grouping container with a header label).',
    parameters: Type.Object({
      label: Type.String({ description: 'Header label for the section (shown on the canvas).' }),
      x: Type.Optional(Type.Number({ description: 'X position (canvas-space).' })),
      y: Type.Optional(Type.Number({ description: 'Y position (canvas-space).' })),
      width: Type.Optional(Type.Number({ description: 'Width in px. Default 480.' })),
      height: Type.Optional(Type.Number({ description: 'Height in px. Default 320.' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const id = crypto.randomUUID();
      const patch: CanvasPatch = {
        op: 'add_section',
        shapeId: id,
        shape: {
          id,
          type: 'section',
          name: params.label,
          label: params.label,
          x: Number(params.x) || 0,
          y: Number(params.y) || 0,
          width: Number(params.width) || 480,
          height: Number(params.height) || 320,
        },
        summary: `Created section "${params.label}"`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Created section "${params.label}" (id: ${id}).` }],
        details: { patch, id, label: params.label },
      };
    },
  });

  const createComponent = defineTool({
    name: 'pen_create_component',
    label: 'Create Component',
    description:
      'Promote a frame (or create a new one) into a COMPONENT — a reusable design element. ' +
      'Once a component exists, you can create INSTANCES of it via pen_create_ref.',
    promptSnippet: 'Create a reusable COMPONENT.',
    parameters: Type.Object({
      name: Type.String({ description: 'Component name. E.g. "Primary Button", "User Card".' }),
      x: Type.Optional(Type.Number({ description: 'X position (canvas-space).' })),
      y: Type.Optional(Type.Number({ description: 'Y position (canvas-space).' })),
      width: Type.Optional(Type.Number({ description: 'Width in px. Default 200.' })),
      height: Type.Optional(Type.Number({ description: 'Height in px. Default 48.' })),
      fill: Type.Optional(Type.String({ description: 'Fill color (hex). Default "#e2e8f0".' })),
      radius: Type.Optional(Type.Number({ description: 'Corner radius in px. Default 6.' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const id = crypto.randomUUID();
      const patch: CanvasPatch = {
        op: 'create_component',
        shapeId: id,
        shape: {
          id,
          type: 'component',
          name: params.name,
          x: Number(params.x) || 0,
          y: Number(params.y) || 0,
          width: Number(params.width) || 200,
          height: Number(params.height) || 48,
          fill: params.fill ?? '#e2e8f0',
          radius: Number(params.radius) || 6,
        },
        summary: `Created component "${params.name}"`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Created component "${params.name}" (id: ${id}). Now use pen_create_ref to place instances.` }],
        details: { patch, id, name: params.name },
      };
    },
  });

  const createComponentSet = defineTool({
    name: 'pen_create_component_set',
    label: 'Create Component Set',
    description:
      'Create a COMPONENT_SET — a container for VARIANTS of a component. ' +
      'After creating the set, call pen_add_variant for each variant combination. ' +
      'Each variant\'s name follows Figma\'s convention: "Property=Value, Property=Value".',
    promptSnippet: 'Create a COMPONENT_SET for variants.',
    parameters: Type.Object({
      name: Type.String({ description: 'Display name for the component set. E.g. "Button", "Input".' }),
      variantPropertyAxes: Type.Array(Type.String(), {
        description: 'Property axes that vary across variants. E.g. ["size", "state"].',
      }),
      variantLayout: Type.Optional(Type.Union(
        [Type.Literal('horizontal'), Type.Literal('vertical'), Type.Literal('grid')],
        { description: 'How variants are arranged. Default "grid".' },
      )),
      x: Type.Optional(Type.Number({ description: 'X position (canvas-space).' })),
      y: Type.Optional(Type.Number({ description: 'Y position (canvas-space).' })),
      width: Type.Optional(Type.Number({ description: 'Width in px. Default 400.' })),
      height: Type.Optional(Type.Number({ description: 'Height in px. Default 200.' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const id = crypto.randomUUID();
      const patch: CanvasPatch = {
        op: 'create_component_set',
        shapeId: id,
        shape: {
          id,
          type: 'component_set',
          name: params.name,
          x: Number(params.x) || 0,
          y: Number(params.y) || 0,
          width: Number(params.width) || 400,
          height: Number(params.height) || 200,
        },
        variantPropertyAxes: params.variantPropertyAxes,
        summary: `Created component set "${params.name}" with axes [${params.variantPropertyAxes.join(', ')}]`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{
          type: 'text',
          text:
            `Created component set "${params.name}" (id: ${id}) with variant axes [${params.variantPropertyAxes.join(', ')}]. ` +
            `Now call pen_add_variant for each variant combination. Remember the naming convention: ` +
            `"Property=Value, Property=Value" (e.g. "Size=Large, State=Hover").`,
        }],
        details: { patch, id, name: params.name, variantPropertyAxes: params.variantPropertyAxes },
      };
    },
  });

  const addVariant = defineTool({
    name: 'pen_add_variant',
    label: 'Add Variant',
    description:
      'Add a variant COMPONENT to an existing component_set. The variant\'s name is auto-derived ' +
      'from the variantPropertyValues you pass — e.g. {size: "large", state: "hover"} becomes "Size=Large, State=Hover".',
    promptSnippet: 'Add a variant to a component_set.',
    parameters: Type.Object({
      componentSetId: Type.String({
        description: 'ID of the component_set to add the variant to.',
      }),
      variantPropertyValues: Type.Record(Type.String(), Type.String(), {
        description:
          'Values for each variant axis. E.g. {size: "large", state: "hover"}. ' +
          'Keys must match the component_set\'s variantPropertyAxes.',
      }),
      fill: Type.Optional(Type.String({ description: 'Fill color (hex) for this variant.' })),
      width: Type.Optional(Type.Number({ description: 'Width in px.' })),
      height: Type.Optional(Type.Number({ description: 'Height in px.' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const id = crypto.randomUUID();
      const name = Object.entries(params.variantPropertyValues)
        .map(([k, v]) => `${k.charAt(0).toUpperCase() + k.slice(1)}=${v.charAt(0).toUpperCase() + v.slice(1)}`)
        .join(', ');
      const patch: CanvasPatch = {
        op: 'add_variant',
        shapeId: id,
        shape: {
          id,
          type: 'component',
          name,
          width: Number(params.width) || 200,
          height: Number(params.height) || 48,
          fill: params.fill ?? '#e2e8f0',
          parentId: params.componentSetId,
        },
        variantPropertyValues: params.variantPropertyValues,
        summary: `Added variant "${name}" to component set`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Added variant "${name}" (id: ${id}) to component set ${params.componentSetId}.` }],
        details: { patch, id, name, variantPropertyValues: params.variantPropertyValues },
      };
    },
  });

  const setComponentProperty = defineTool({
    name: 'pen_set_component_property',
    label: 'Set Component Property',
    description:
      'Define a component property on a COMPONENT. Figma\'s 4 property types: ' +
      'boolean (toggle visibility), text (string override), instance_swap (swap to another component), ' +
      'variant (pick a variant from the component_set).',
    promptSnippet: 'Define a component property (boolean/text/instance_swap/variant).',
    parameters: Type.Object({
      componentId: Type.String({ description: 'ID of the COMPONENT to add the property to.' }),
      propertyName: Type.String({
        description: 'Property name (kebab-case). E.g. "show-icon", "label-text", "state".',
      }),
      propertyType: Type.Union(
        [Type.Literal('boolean'), Type.Literal('text'), Type.Literal('instance_swap'), Type.Literal('variant'), Type.Literal('slot')],
        { description: 'Property type. slot = Figma SLOT (placeholder for instance swap).' },
      ),
      defaultValue: Type.Union([Type.Boolean(), Type.String()], {
        description: 'Default value. boolean=true/false, text="Submit", variant="default".',
      }),
      preferredValues: Type.Optional(Type.Array(Type.String(), {
        description: 'For instance_swap: list of component IDs that can be swapped in.',
      })),
      variantOptions: Type.Optional(Type.Array(Type.String(), {
        description: 'For variant: list of valid option values. E.g. ["default", "hover", "disabled"].',
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const patch: CanvasPatch = {
        op: 'set_component_property',
        shapeId: params.componentId,
        componentProperty: {
          name: params.propertyName,
          type: params.propertyType,
          defaultValue: params.defaultValue,
          preferredValues: Array.isArray(params.preferredValues) ? params.preferredValues.map(String) : undefined,
          variantOptions: Array.isArray(params.variantOptions) ? params.variantOptions.map(String) : undefined,
        },
        summary: `Set component property "${params.propertyName}" (${params.propertyType}) on ${params.componentId}`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{
          type: 'text',
          text:
            `Set component property "${params.propertyName}" (type: ${params.propertyType}, default: ${JSON.stringify(params.defaultValue)}) ` +
            `on component ${params.componentId}. Instances can now override this property.`,
        }],
        details: {
          patch,
          componentId: params.componentId,
          propertyName: params.propertyName,
          propertyType: params.propertyType,
          defaultValue: params.defaultValue,
        },
      };
    },
  });

  const setInstanceProperty = defineTool({
    name: 'pen_set_instance_property',
    label: 'Set Instance Property Override',
    description:
      'Override a component property on an existing INSTANCE (PenRef). Use this to customize a placed ' +
      'component instance — e.g. change its label text, hide an icon, swap to a different variant.',
    promptSnippet: 'Override a component property on an instance.',
    parameters: Type.Object({
      instanceId: Type.String({ description: 'ID of the instance (PenRef) to override.' }),
      propertyName: Type.String({
        description: 'Property name (kebab-case). Must match a property defined on the component.',
      }),
      value: Type.Union([Type.Boolean(), Type.String()], {
        description: 'Override value. boolean=true/false, text="Cancel", variant="hover".',
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const patch: CanvasPatch = {
        op: 'set_instance_property',
        shapeId: params.instanceId,
        instancePropertyName: params.propertyName,
        instancePropertyValue: params.value,
        summary: `Set instance property "${params.propertyName}" = ${JSON.stringify(params.value)} on ${params.instanceId}`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{
          type: 'text',
          text: `Overrode property "${params.propertyName}" = ${JSON.stringify(params.value)} on instance ${params.instanceId}.`,
        }],
        details: {
          patch,
          instanceId: params.instanceId,
          propertyName: params.propertyName,
          value: params.value,
        },
      };
    },
  });

  return [
    createPage,
    setActivePage,
    renamePage,
    deletePage,
    createSection,
    createComponent,
    createComponentSet,
    addVariant,
    setComponentProperty,
    setInstanceProperty,
  ];
}

// Canonical names (spec Phase 6 / G.3 — the figma_* surface folded into the
// pen_* names, closing D10): the `figma_*` spellings resolve through the alias
// registry in tool-aliases.ts and remain PERMANENT aliases.
export const FIGMA_TOOL_NAMES = [
  'pen_create_page',
  'pen_set_active_page',
  'pen_rename_page',
  'pen_delete_page',
  'pen_create_section',
  'pen_create_component',
  'pen_create_component_set',
  'pen_add_variant',
  'pen_set_component_property',
  'pen_set_instance_property',
] as const;

/// Legacy `figma_*` alias names (kept in the always-on exposure sets during
/// the window; payloads were already Figma-shaped, so nothing else changes).
export const FIGMA_TOOL_LEGACY_NAMES = [
  'figma_create_page',
  'figma_set_active_page',
  'figma_rename_page',
  'figma_delete_page',
  'figma_create_section',
  'figma_create_component',
  'figma_create_component_set',
  'figma_add_variant',
  'figma_set_component_property',
  'figma_set_instance_property',
] as const;
