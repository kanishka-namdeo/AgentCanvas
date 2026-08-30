// Reproduce the SDK's tool-args validation for pen_generate_variants
// with the CURRENT schema (Type.Number 2..3) and a stringified "3".
import { validateToolArguments as t } from '@openclaw/ai';
import { Type } from '@sinclair/typebox';

const currentSchema = Type.Object({
  request: Type.String(),
  directions: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 3 })),
  variantCount: Type.Optional(Type.Number({ minimum: 2, maximum: 3, description: 'How many variants (default 3).' })),
});

// Hypothesis: legacy union schema still live somewhere
const legacySchema = Type.Object({
  request: Type.String(),
  variantCount: Type.Optional(Type.Union([Type.Literal(2), Type.Literal(3)])),
});

function tryValidate(label, tool, args) {
  try {
    const out = t(tool, { name: tool.name, arguments: structuredClone(args) });
    console.log(`[${label}] PASS ->`, JSON.stringify(out));
  } catch (e) {
    console.log(`[${label}] FAIL ->`, String(e.message).split('\n').slice(0, 8).join(' | '));
  }
}

const mkTool = (schema) => ({ name: 'pen_generate_variants', parameters: schema });

const argsFromString = JSON.parse('{"request":"landing page","variantCount":"3"}');
const argsNum = { request: 'landing page', variantCount: 3 };
const argsOmitted = { request: 'landing page' };

tryValidate('current/string-3', mkTool(currentSchema), argsFromString);
tryValidate('current/number-3', mkTool(currentSchema), argsNum);
tryValidate('current/omitted', mkTool(currentSchema), argsOmitted);
tryValidate('legacy/string-3', mkTool(legacySchema), argsFromString);
