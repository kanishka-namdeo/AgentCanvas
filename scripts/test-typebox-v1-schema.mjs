// Prove the fix: schemas built with `typebox` v1.3.7 (the SAME package the
// SDK uses) get full string->number coercion in the SDK's validation path.
import { validateToolArguments as t } from '@openclaw/ai';
import { Type } from 'typebox';

function tryValidate(label, schema, args) {
  try {
    const out = t({ name: 'probe', parameters: schema }, { name: 'probe', arguments: structuredClone(args) });
    console.log(`[${label}] PASS ->`, JSON.stringify(out));
  } catch (e) {
    console.log(`[${label}] FAIL ->`, String(e.message).split('\n').slice(0, 6).join(' | '));
  }
}

// The exact pen_generate_variants schema, typebox-v1-built
const variantsSchema = Type.Object({
  request: Type.String(),
  directions: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 3 })),
  variantCount: Type.Optional(Type.Number({ minimum: 2, maximum: 3, description: 'How many variants (default 3).' })),
});

tryValidate('tb1/optional-number/string-3', variantsSchema, { request: 'x', variantCount: '3' });
tryValidate('tb1/optional-number/number-3', variantsSchema, { request: 'x', variantCount: 3 });
tryValidate('tb1/omitted', variantsSchema, { request: 'x' });
tryValidate('tb1/out-of-range-7 (should FAIL)', variantsSchema, { request: 'x', variantCount: '7' });

// Style fields like fontSize / nested shapes
const shapeSchema = Type.Object({
  style: Type.Object({ fontSize: Type.Optional(Type.Number()), opacity: Type.Optional(Type.Number()) }),
  x: Type.Optional(Type.Number()),
});
tryValidate('tb1/nested-style/string-numbers', shapeSchema, { style: { fontSize: '24', opacity: '0.8' }, x: '10' });

// Literal unions (alignX etc.) still enforce exact values
const alignSchema = Type.Object({ alignX: Type.Optional(Type.Union([Type.Literal('min'), Type.Literal('center'), Type.Literal('max')])) });
tryValidate('tb1/literal-union/valid', alignSchema, { alignX: 'center' });
tryValidate('tb1/literal-union/invalid (should FAIL)', alignSchema, { alignX: 'middle' });

// Static type inference still works with typebox v1?
const s = Type.Object({ a: Type.Optional(Type.Number()) });
const val = { a: '5' };
console.log('static inference OK:', typeof s.properties.a);
