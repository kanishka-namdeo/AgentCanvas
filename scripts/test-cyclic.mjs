// Probe Type.Cyclic (typebox v1's recursive replacement) through the SDK validator.
import { validateToolArguments as t } from '@openclaw/ai';
import { Type } from 'typebox';

const SubtreeNodeSchema = Type.Cyclic(
  {
    node: Type.Object({
      type: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      fontSize: Type.Optional(Type.Number()),
      children: Type.Optional(
        Type.Union([Type.Array(Type.Ref('#/$defs/node')), Type.String()], {
          description: 'Nested child nodes — array or JSON string.',
        }),
      ),
    }),
  },
  '#/$defs/node',
);

const params = Type.Object({
  node: Type.Union([SubtreeNodeSchema, Type.String()]),
});

function tryValidate(label, schema, args) {
  try {
    const out = t({ name: 'probe', parameters: schema }, { name: 'probe', arguments: structuredClone(args) });
    console.log(`[${label}] PASS ->`, JSON.stringify(out).slice(0, 140));
  } catch (e) {
    console.log(`[${label}] FAIL ->`, String(e.message).split('\n').slice(0, 5).join(' | '));
  }
}

tryValidate('cyclic/valid-nested-number-coerce', params, {
  node: { type: 'frame', children: [{ type: 'text', fontSize: '24' }] },
});
tryValidate('cyclic/string-node', params, { node: '[{"type":"text"}]' });
tryValidate('cyclic/garbage (should FAIL)', params, { node: 42 });
console.log('JSON emitted:', JSON.stringify(SubtreeNodeSchema).slice(0, 200));
