// Pin down the SDK's coercion behavior for Optional(Number) fields,
// required Number fields, and unions — to choose the right schema shapes.
import { validateToolArguments as t } from '@openclaw/ai';
import { Type } from '@sinclair/typebox';

function tryValidate(label, schema, args) {
  try {
    const out = t({ name: 'probe', parameters: schema }, { name: 'probe', arguments: structuredClone(args) });
    console.log(`[${label}] PASS ->`, JSON.stringify(out));
  } catch (e) {
    console.log(`[${label}] FAIL ->`, String(e.message).split('\n').filter((l) => l.includes('must') || l.includes('- ')).slice(0, 4).join(' | '));
  }
}

// 1. Optional Number, string input (style fields like fontSize)
tryValidate(
  'optional-number/string',
  Type.Object({ fontSize: Type.Optional(Type.Number({ description: 'Font size' })) }),
  { fontSize: '24' },
);

// 2. Required Number, string input
tryValidate(
  'required-number/string',
  Type.Object({ count: Type.Number({ minimum: 2, maximum: 3 }) }),
  { count: '3' },
);

// 3. Number inside nested object (style sub-object)
tryValidate(
  'nested-number/string',
  Type.Object({ style: Type.Object({ fontSize: Type.Optional(Type.Number()) }) }),
  { style: { fontSize: '24' } },
);

// 4. Union [Number, String] + clamp in execute
tryValidate(
  'union-number-string/string',
  Type.Object({ variantCount: Type.Optional(Type.Union([Type.Number(), Type.String()])) }),
  { variantCount: '3' },
);

// 5. Union [Number, String] + real number still fine
tryValidate(
  'union-number-string/number',
  Type.Object({ variantCount: Type.Optional(Type.Union([Type.Number(), Type.String()])) }),
  { variantCount: 3 },
);

// 6. What does Value.Convert do standalone for optional number?
import { Value } from '@sinclair/typebox/value';
const sch = Type.Object({ fontSize: Type.Optional(Type.Number()) });
const val = { fontSize: '24' };
Value.Convert(sch, val);
console.log('[value-convert/optional-number] after:', JSON.stringify(val));

const sch2 = Type.Object({ fontSize: Type.Optional(Type.Number()) });
const val2 = { fontSize: '24' };
Value.Convert(sch2.properties.fontSize, val2.fontSize);
console.log('[value-convert/direct-prop] after:', JSON.stringify(val2));
