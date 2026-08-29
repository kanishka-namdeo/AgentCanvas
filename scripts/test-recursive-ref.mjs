// Probe: does the SDK validator accept a hand-built JSON-Schema recursive
// ($ref/$defs) schema, coerce numbers inside it, and keep maxItems etc.?
import { validateToolArguments as t } from '@openclaw/ai';
import { Type } from 'typebox';

// Plain JSON Schema (no TypeBox builder): recursive subtree node via $ref.
const nodeSchema = {
  type: 'object',
  $defs: {
    node: {
      type: 'object',
      properties: {
        type: { type: 'string' },
        name: { type: 'string' },
        x: { type: ['number', 'string'], description: 'px or sizing string' },
        fontSize: { type: 'number' },
        children: {
          description: 'Nested child nodes',
          anyOf: [{ type: 'array', items: { $ref: '#/$defs/node' } }, { type: 'string' }],
        },
      },
    },
  },
  properties: {
    node: { $ref: '#/$defs/node' },
  },
  required: ['node'],
};

function tryValidate(label, schema, args) {
  try {
    const out = t({ name: 'probe', parameters: schema }, { name: 'probe', arguments: structuredClone(args) });
    console.log(`[${label}] PASS ->`, JSON.stringify(out).slice(0, 160));
  } catch (e) {
    console.log(`[${label}] FAIL ->`, String(e.message).split('\n').slice(0, 5).join(' | '));
  }
}

tryValidate('ref-schema/valid-nested', nodeSchema, {
  node: { type: 'frame', children: [{ type: 'text', fontSize: '24', children: '[{"type":"text"}]' }] },
});
tryValidate('ref-schema/garbage (should FAIL)', nodeSchema, { node: 42 });
tryValidate('ref-schema/missing-node (should FAIL)', nodeSchema, {});
