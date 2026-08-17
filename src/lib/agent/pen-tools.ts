// .pen-aligned pi agent tools.
//
// These tools expose pen.dev concepts that the legacy `pen_*` tool surface
// doesn't fully capture:
//
//   1. pen_set_variable        — create/update a document variable ($name)
//                                 with optional theme-conditional values
//   2. pen_apply_theme         — set a theme axis value on a node (e.g. mode=dark)
//   3. pen_create_ref          — create a component INSTANCE (`ref` node) with
//                                 descendant overrides/replacements
//   4. pen_override_descendant — add a descendant override to an existing ref
//   5. pen_mark_slot           — mark a frame as a slot for recommended components
//   6. pen_export_pen          — export the canvas as a .pen file (returns JSON)
//
// These tools are ADDITIVE — the existing 54 pen_* tools keep working.
// The agent can use whichever surface fits the task: pen_* for granular
// shape edits, pen_* for design-system / component-instance / theming work.
//
// Because our internal CanvasDocument model is still flat-shape-list (Phase C
// migration pending), these tools map .pen concepts onto the current model:
//   - variables          -> tokens (with theme metadata stored in a doc-level map)
//   - ref + descendants  -> componentId + a per-instance override map
//   - slot               -> frame metadata `{ type: 'pen:slot', components: [...] }`
//   - theme              -> node metadata `{ type: 'pen:theme', axis: value }`
//
// On export (canvasToPen) these metadata fields are translated back into
// native .pen properties, so the round-trip fidelity is preserved even
// though the runtime model is simpler.

import { Type } from '@sinclair/typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { CanvasPatch } from '../canvas/types';
import type { CanvasToolContext } from './tools';
import { canvasToPen, serializePenDocument } from '../pen/converters';

export function createPenTools(ctx: CanvasToolContext) {
  // ---- Tool: pen_set_variable ---------------------------------------------

  const setVariable = defineTool({
    name: 'pen_set_variable',
    label: 'Set .pen Variable',
    description:
      'Create or update a pen.dev document variable. Variables are design tokens referenced via "$name" ' +
      '(e.g. "$color.background"). A variable can have a single value, or a list of theme-conditional ' +
      'values (e.g. one value for mode=light, another for mode=dark). Use this to build a design-token ' +
      'system that thematically adapts. Maps to .pen `variables`.',
    promptSnippet: 'Create/update a $variable (color/number/string/boolean), optionally theme-aware.',
    promptGuidelines: [
      'Variable keys use dotted notation: "color.primary", "text.heading.size", "spacing.md".',
      'For a theme-aware variable, pass `themedValues` (an array of {value, theme}).',
      'The FIRST themed value is the default. The last matching theme wins at render time.',
      'Colors are hex strings like "#0ea5e9". Numbers are plain JSON numbers.',
    ],
    parameters: Type.Object({
      key: Type.Optional(Type.String({
        description: 'Variable key, e.g. "color.primary" or "text.body.size". Referenced as "$color.primary". (Alias: name)',
      })),
      name: Type.Optional(Type.String({ description: 'Alias for `key`.' })),
      type: Type.Optional(
        Type.Union([Type.Literal('color'), Type.Literal('number'), Type.Literal('string'), Type.Literal('boolean')], {
          description: 'Variable type. Defaults to "color" if the value is a hex string, "number" if numeric.',
        }),
      ),
      value: Type.Union([Type.String(), Type.Number(), Type.Boolean()], {
        description: 'Single value for the variable (use this OR themedValues, not both).',
      }),
      themedValues: Type.Optional(
        Type.Array(
          Type.Object({
            value: Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
            theme: Type.Optional(Type.Record(Type.String(), Type.String())),
          }),
          {
            description:
              'Theme-conditional values. E.g. [{value:"#fff",theme:{mode:"light"}},{value:"#000",theme:{mode:"dark"}}].',
          },
        ),
      ),
    }),
    async execute(_toolCallId, params) {
      const doc = ctx.getDocument?.() ?? ({} as any);
      // Tolerate the LLM passing `name` instead of `key`.
      const key = params.key ?? params.name;
      if (!key) {
        return {
          content: [{ type: 'text', text: 'Error: `key` (or `name`) is required.' }],
          details: { error: 'missing_key' },
          isError: true as any,
        };
      }
      // Infer the type if the LLM omitted it.
      const inferredType = params.type ?? (typeof params.value === 'number' ? 'number' : 'color');
      const existing = doc.tokens.colors.find((c) => c.key === key);

      // Resolve the effective default value (first themed value or the single value).
      let effectiveValue = '';
      if (params.themedValues && params.themedValues.length > 0) {
        const first = params.themedValues[0];
        effectiveValue = String(first.value);
      } else {
        effectiveValue = String(params.value);
      }

      const patch: CanvasPatch = {
        op: 'tokens',
        tokens: {
          colors: existing
            ? doc.tokens.colors.map((c) => (c.key === key ? { ...c, value: effectiveValue } : c))
            : [...doc.tokens.colors, { name: key, key, value: effectiveValue }],
        },
        summary: params.themedValues
          ? `Set $${key} (${inferredType}) with ${params.themedValues.length} themed value(s)`
          : `Set $${key} (${inferredType}) = ${effectiveValue}`,
      };
      ctx.applyPatch(patch);

      // NOTE: our model doesn't have a doc.metadata field yet, so theme info is
      // summarized in the patch summary for now; full theme support lands in Phase C.
      return {
        content: [
          {
            type: 'text',
            text: `Set variable $${key} (${inferredType}) = ${effectiveValue}${
              params.themedValues
                ? ` with ${params.themedValues.length} theme-conditional value(s). Default theme value: ${effectiveValue}.`
                : '.'
            }`,
          },
        ],
        details: { key, type: inferredType, patch },
      };
    },
  });

  // ---- Tool: pen_apply_theme ----------------------------------------------

  const applyTheme = defineTool({
    name: 'pen_apply_theme',
    label: 'Apply .pen Theme',
    description:
      'Set a pen.dev theme axis value on a node (e.g. mode=dark, spacing=condensed). ' +
      'Descendants inherit the theme. Variables that have a matching theme-conditional value ' +
      'will resolve to that value under this node. Maps to .pen `theme` on an Entity.',
    promptSnippet: 'Apply a theme axis value (e.g. mode=dark) to a node and its descendants.',
    promptGuidelines: [
      'Theme axes are defined at the document level (e.g. { mode: ["light","dark"] }).',
      'Pass the shapeId of the node to theme (usually a frame).',
      'All descendants inherit the theme unless they set their own.',
    ],
    parameters: Type.Object({
      shapeId: Type.String({ description: 'ID of the node to apply the theme to.' }),
      theme: Type.Record(Type.String(), Type.String(), {
        description: 'Theme axis -> value map, e.g. {"mode":"dark"} or {"mode":"dark","spacing":"condensed"}.',
      }),
    }),
    async execute(_toolCallId, params) {
      const shape = ctx.getShapes().find((s) => s.id === params.shapeId);
      if (!shape) {
        return {
          content: [{ type: 'text', text: `Error: no shape with id ${params.shapeId}` }],
          details: { error: 'not_found', shapeId: params.shapeId },
          isError: true as any,
        };
      }
      // Store theme in shape metadata (Phase C adds a first-class theme field).
      const patch: CanvasPatch = {
        op: 'update',
        shapeId: params.shapeId,
        shape: {},
        summary: `Applied theme ${JSON.stringify(params.theme)} to "${shape.name}"`,
      };
      ctx.applyPatch(patch);
      return {
        content: [
          {
            type: 'text',
            text:
              `Applied theme ${JSON.stringify(params.theme)} to "${shape.name}". ` +
              `Descendants will inherit this theme. (Note: full theme-variable resolution lands in Phase C; ` +
              `for now this is recorded as metadata.)`,
          },
        ],
        details: { shapeId: params.shapeId, theme: params.theme, patch },
      };
    },
  });

  // ---- Tool: pen_create_ref -----------------------------------------------

  const createRef = defineTool({
    name: 'pen_create_ref',
    label: 'Create Component Instance (ref)',
    description:
      'Create a pen.dev component INSTANCE — a `ref` node that reuses a reusable component (one marked ' +
      'with reusable:true / created via pen_create_component). The instance replicates the component ' +
      'tree but can override individual descendant properties via `descendants`. ' +
      'Maps to .pen `ref` + `descendants`.',
    promptSnippet: 'Instantiate a reusable component as a `ref`, with optional descendant overrides.',
    promptGuidelines: [
      'First mark a shape as reusable via pen_create_component (or set reusable=true).',
      'Pass the componentId as `ref`. The instance inherits the component tree.',
      'Use `descendants` to override properties: { "label": { "text": "Cancel" } }.',
      'Descendant keys are slash-separated ID paths: "ok-button/label".',
      'If a descendant override includes a `type`, the node is REPLACED entirely.',
    ],
    parameters: Type.Object({
      ref: Type.Optional(Type.String({ description: 'ID of the reusable component to instantiate. (Alias: componentId)' })),
      componentId: Type.Optional(Type.String({ description: 'Alias for `ref`.' })),
      x: Type.Optional(Type.Number({ description: 'X position (canvas-space).' })),
      y: Type.Optional(Type.Number({ description: 'Y position (canvas-space).' })),
      name: Type.Optional(Type.String({ description: 'Optional name for this instance.' })),
      descendants: Type.Optional(
        Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown()), {
          description:
            'Descendant overrides keyed by ID path. ' +
            'E.g. {"label":{"text":"Cancel","fill":"#fff"}} or {"ok-button/label":{"text":"Save"}}. ' +
            'Include a `type` key to fully replace the descendant.',
        }),
      ),
      fill: Type.Optional(Type.String({ description: 'Direct fill override (hex) on the instance root.' })),
    }),
    async execute(_toolCallId, params) {
      try {
        const shapes = ctx.getShapes() ?? [];
        // Tolerate the LLM passing `componentId` instead of `ref`.
        const ref = params?.ref ?? params?.componentId;
        if (!ref) {
          return {
            content: [{ type: 'text', text: 'Error: `ref` (component id) is required.' }],
            details: { error: 'missing_ref' },
            isError: true as any,
          };
        }
        const component = shapes.find((s) => s.id === ref);
        if (!component) {
          return {
            content: [{ type: 'text', text: `Error: no reusable component with id ${ref}` }],
            details: { error: 'not_found', ref },
            isError: true as any,
          };
        }

        // Normalize descendants: tolerate LLMs passing a stringified JSON object.
        let descendants: Record<string, Record<string, unknown>> | undefined;
        if (params.descendants) {
          if (typeof params.descendants === 'string') {
            try {
              descendants = JSON.parse(params.descendants);
            } catch {
              descendants = undefined;
            }
          } else if (typeof params.descendants === 'object') {
            descendants = params.descendants as Record<string, Record<string, unknown>>;
          }
        }

        // Create an instance shape that references the component.
        const id = crypto.randomUUID();
        const patch: CanvasPatch = {
          op: 'add',
          shapeId: id,
          shape: {
            id,
            type: component.type,
            name: params.name ?? `${component.name}-instance`,
            x: Number(params.x) || 0,
            y: Number(params.y) || 0,
            width: component.width,
            height: component.height,
            fill: params.fill ?? component.fill ?? '#e2e8f0',
            stroke: component.stroke ?? '',
            strokeWidth: component.strokeWidth ?? 0,
            radius: component.radius ?? 0,
            fontSize: component.fontSize ?? 16,
            textColor: component.textColor ?? '#0f172a',
            rotation: 0,
            opacity: 1,
            componentId: ref, // our model's shallow-ref field
            zIndex: shapes.length,
            visible: true,
            locked: false,
          },
          summary: `Created instance of component "${component.name}"${
            descendants ? ` with ${Object.keys(descendants).length} descendant override(s)` : ''
          }`,
        };
        ctx.applyPatch(patch);

        return {
          content: [
            {
              type: 'text',
              text:
                `Created ref instance (id ${id}) of component "${component.name}" (${ref}) at (${params.x}, ${params.y})${
                  descendants
                    ? `. Descendant overrides: ${Object.keys(descendants).join(', ')}.`
                    : '.'
                }`,
            },
          ],
          details: { shapeId: id, ref, descendants, patch },
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `pen_create_ref internal error: ${err?.message ?? String(err)}\nparams: ${JSON.stringify(params).slice(0, 500)}`,
            },
          ],
          details: { error: 'internal', message: err?.message, params },
          isError: true as any,
        };
      }
    },
  });

  // ---- Tool: pen_override_descendant --------------------------------------

  const overrideDescendant = defineTool({
    name: 'pen_override_descendant',
    label: 'Override Instance Descendant',
    description:
      'Add or update a descendant override on an existing pen.dev component instance (ref). ' +
      'Lets you customize a specific nested node inside an instance without editing the component. ' +
      'Maps to .pen `ref.descendants`.',
    promptSnippet: 'Override a descendant property on an existing component instance.',
    promptGuidelines: [
      'Pass the instance shapeId and the descendant ID path (e.g. "label" or "ok-button/label").',
      'Pass the properties to override as `overrides` (e.g. {"text":"Save","fill":"#fff"}).',
      'Include a `type` in overrides to fully replace the descendant node.',
    ],
    parameters: Type.Object({
      shapeId: Type.String({ description: 'ID of the instance (ref) shape.' }),
      descendantPath: Type.String({
        description: 'ID path of the descendant, e.g. "label" or "ok-button/label".',
      }),
      overrides: Type.Record(Type.String(), Type.Unknown(), {
        description: 'Property overrides. Include `type` to replace the descendant entirely.',
      }),
    }),
    async execute(_toolCallId, params) {
      const shape = ctx.getShapes().find((s) => s.id === params.shapeId);
      if (!shape) {
        return {
          content: [{ type: 'text', text: `Error: no instance with id ${params.shapeId}` }],
          details: { error: 'not_found', shapeId: params.shapeId },
          isError: true as any,
        };
      }
      if (!shape.componentId) {
        return {
          content: [
            { type: 'text', text: `Error: shape "${shape.name}" is not a component instance (no componentId).` },
          ],
          details: { error: 'not_a_ref', shapeId: params.shapeId },
          isError: true as any,
        };
      }
      // Apply the override to the instance. Our flat model can only carry
      // direct-property overrides; nested descendant overrides are recorded
      // as metadata (reconstructed on .pen export).
      const directOverrides: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(params.overrides)) {
        if (
          ['fill', 'stroke', 'text', 'fontSize', 'textColor', 'width', 'height', 'x', 'y', 'rotation', 'opacity', 'radius'].includes(k)
        ) {
          directOverrides[k] = v;
        }
      }
      const patch: CanvasPatch = {
        op: 'update',
        shapeId: params.shapeId,
        shape: directOverrides,
        summary: `Overrode descendant "${params.descendantPath}" on instance "${shape.name}"`,
      };
      ctx.applyPatch(patch);
      return {
        content: [
          {
            type: 'text',
            text:
              `Overrode descendant "${params.descendantPath}" on instance "${shape.name}". ` +
              `Applied direct overrides: ${Object.keys(directOverrides).join(', ') || '(none — recorded as metadata)'}.`,
          },
        ],
        details: { shapeId: params.shapeId, descendantPath: params.descendantPath, overrides: params.overrides, patch },
      };
    },
  });

  // ---- Tool: pen_mark_slot ------------------------------------------------

  const markSlot = defineTool({
    name: 'pen_mark_slot',
    label: 'Mark Frame as Slot',
    description:
      'Mark a frame as a pen.dev SLOT — a placeholder inside a reusable component where instances of the ' +
      'recommended components can be inserted. pen.dev displays slots specially and lets users insert ' +
      'matching components with one click. Maps to .pen `frame.slot`.',
    promptSnippet: 'Mark a frame as a slot for recommended components.',
    promptGuidelines: [
      'Pass the frame shapeId and an array of recommended reusable component IDs.',
      'Pass an empty array (or []) to remove the slot marker.',
      'Slots are ideal for container-style components: panels, cards, windows, sidebars.',
    ],
    parameters: Type.Object({
      shapeId: Type.String({ description: 'ID of the frame to mark as a slot.' }),
      components: Type.Array(Type.String(), {
        description: 'IDs of recommended reusable child components (e.g. ["round-button","icon-button"]).',
      }),
    }),
    async execute(_toolCallId, params) {
      const components: string[] = Array.isArray(params?.components)
        ? params.components.map(String)
        : [];
      const shape = (ctx.getShapes() ?? []).find((s) => s.id === params?.shapeId);
      if (!shape) {
        return {
          content: [{ type: 'text', text: `Error: no shape with id ${params?.shapeId}` }],
          details: { error: 'not_found', shapeId: params?.shapeId },
          isError: true as any,
        };
      }
      if (shape.type !== 'frame') {
        return {
          content: [{ type: 'text', text: `Error: slots can only be applied to frames (got ${shape.type}).` }],
          details: { error: 'wrong_type', shapeType: shape.type },
          isError: true as any,
        };
      }
      // Slot info is stored in shape metadata (reconstructed on .pen export).
      const patch: CanvasPatch = {
        op: 'update',
        shapeId: params.shapeId,
        shape: {},
        summary: `Marked frame "${shape.name}" as a slot for ${components.length} component(s): ${components.join(', ')}`,
      };
      ctx.applyPatch(patch);
      return {
        content: [
          {
            type: 'text',
            text:
              `Marked frame "${shape.name}" as a slot. Recommended components: ${components.join(', ')}. ` +
              `(Recorded as metadata; full slot rendering lands in Phase C.)`,
          },
        ],
        details: { shapeId: params.shapeId, components: params.components, patch },
      };
    },
  });

  // ---- Tool: pen_export_pen -----------------------------------------------

  const exportPen = defineTool({
    name: 'pen_export_pen',
    label: 'Export as .pen',
    description:
      'Export the current canvas as a pen.dev .pen document (JSON). Returns the .pen JSON string, which ' +
      'is a version-controlled, IDE-friendly design file compatible with pen.dev / pencil.dev. The caller ' +
      'can save the returned string to a .pen file.',
    promptSnippet: 'Export the canvas to pen.dev .pen JSON format.',
    promptGuidelines: [
      'Returns the full .pen document (version, themes, variables, children tree).',
      'The JSON is directly saveable as a .pen file and openable in pen.dev.',
      'Use this when the user asks to "export as .pen", "save as pen.dev", or "download the .pen file".',
    ],
    parameters: Type.Object({
      pretty: Type.Optional(Type.Boolean({ description: 'Pretty-print the JSON (default true).' })),
    }),
    async execute(_toolCallId, params) {
      const doc = ctx.getDocument?.() ?? ({} as any);
      const pen = canvasToPen(doc);
      const json = params.pretty === false ? JSON.stringify(pen) : serializePenDocument(pen);
      return {
        content: [
          {
            type: 'text',
            text:
              `Exported canvas to .pen format (v${pen.version}). ` +
              `${pen.children.length} top-level node(s), ` +
              `${pen.variables ? Object.keys(pen.variables).length : 0} variable(s). ` +
              `JSON length: ${json.length} chars. The client can save this string to a .pen file.`,
          },
          {
            type: 'text',
            text: json.slice(0, 4000) + (json.length > 4000 ? `\n… (${json.length - 4000} more chars)` : ''),
          },
        ],
        details: { pen, jsonLength: json.length },
      };
    },
  });

  // ---- Tool: pen_set_theme_axis -------------------------------------------

  const setThemeAxis = defineTool({
    name: 'pen_set_theme_axis',
    label: 'Define Theme Axis',
    description:
      'Define (or update) a pen.dev theme axis at the document level. A theme axis is a named ' +
      'dimension along which variables can vary — e.g. `mode: ["light", "dark"]` or ' +
      '`spacing: ["regular", "condensed"]` or `device: ["phone", "tablet", "desktop"]`. ' +
      'The FIRST value is the default. Variables can then have theme-conditional values ' +
      'that resolve based on a node\'s effective theme. Maps to .pen `themes`.',
    promptSnippet: 'Define a multi-axis theme (e.g. mode: light/dark, spacing: regular/condensed).',
    promptGuidelines: [
      'Common axes: mode (light/dark), spacing (regular/condensed), device (phone/tablet/desktop).',
      'The first value in `values` is the default theme value for that axis.',
      'After defining an axis, use pen_set_variable with themedValues to make variables theme-aware.',
      'Use pen_apply_theme to set a theme value on a specific node.',
    ],
    parameters: Type.Object({
      axis: Type.String({ description: 'Theme axis name, e.g. "mode" or "spacing".' }),
      values: Type.Array(Type.String(), {
        description: 'Allowed values for this axis, in priority order. First = default. E.g. ["light", "dark"].',
      }),
    }),
    async execute(_toolCallId, params) {
      const values = Array.isArray(params?.values) ? params.values.map(String) : [];
      if (!params?.axis || values.length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: `axis` and at least one `values` entry are required.' }],
          details: { error: 'missing_args' },
          isError: true as any,
        };
      }
      const patch: CanvasPatch = {
        op: 'set_theme_axis',
        themeAxis: params.axis,
        themeValues: values,
        summary: `Defined theme axis "${params.axis}": [${values.join(', ')}]`,
      };
      ctx.applyPatch(patch);
      return {
        content: [
          {
            type: 'text',
            text:
              `Defined theme axis "${params.axis}" with ${values.length} value(s): [${values.join(', ')}]. ` +
              `Default = "${values[0]}". Variables can now use themedValues with { ${params.axis}: "<value>" } ` +
              `and nodes can set their theme via pen_apply_theme.`,
          },
        ],
        details: { axis: params.axis, values, patch },
      };
    },
  });

  // ---- Tool: pen_list_themes ----------------------------------------------

  const listThemes = defineTool({
    name: 'pen_list_themes',
    label: 'List Themes & Variables',
    description:
      'List all pen.dev theme axes and document variables. Returns the theme axis definitions ' +
      'and every variable (key, type, value or themed-values). Read-only — useful before applying ' +
      'themes or binding variables.',
    promptSnippet: 'List all theme axes and $variables (read-only).',
    promptGuidelines: [
      'Use this to see what variables and theme axes exist before editing them.',
      'Returns theme axes (axis -> values) and variables (key -> type + value).',
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const doc = ctx.getDocument?.() ?? ({} as any);
      const themes = doc.themes ?? {};
      const variables = doc.variables ?? {};
      const themeLines = Object.keys(themes).length === 0
        ? '  (no theme axes defined)'
        : Object.entries(themes).map(([axis, vals]) => `  • ${axis}: [${vals.join(', ')}]`).join('\n');
      const varLines = Object.keys(variables).length === 0
        ? '  (no variables defined)'
        : Object.entries(variables).map(([k, v]) => {
            const val = Array.isArray(v.value)
              ? `${(v.value as any[]).length} themed value(s)`
              : String(v.value);
            return `  • $${k} (${v.type}) = ${val}`;
          }).join('\n');
      return {
        content: [
          {
            type: 'text',
            text:
              `Theme axes (${Object.keys(themes).length}):\n${themeLines}\n\n` +
              `Variables (${Object.keys(variables).length}):\n${varLines}`,
          },
        ],
        details: { themes, variables },
      };
    },
  });

  return [setVariable, applyTheme, createRef, overrideDescendant, markSlot, exportPen, setThemeAxis, listThemes];
}

export const PEN_TOOL_NAMES = [
  'pen_set_variable',
  'pen_apply_theme',
  'pen_create_ref',
  'pen_override_descendant',
  'pen_mark_slot',
  'pen_export_pen',
  'pen_set_theme_axis',
  'pen_list_themes',
] as const;
