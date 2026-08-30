// Unit probe: extractSpecJson must hydrate JSON-stringified children
// (the qwen stringifying habit) so variant specs don't collapse to
// "too small" and fail the whole exploration.
import { extractSpecJson } from '../src/lib/agent/subagents/variant-generator';

let failures = 0;
function check(label: string, cond: boolean, extra?: string) {
  console.log(`[${label}] ${cond ? 'PASS' : 'FAIL'}${extra ? ' -> ' + extra : ''}`);
  if (!cond) failures++;
}

// 1. Nested children as JSON STRINGS (the observed failure mode)
const stringified = {
  type: 'frame',
  name: 'Landing',
  children: JSON.stringify([
    { type: 'frame', name: 'Hero', children: JSON.stringify([{ type: 'text', text: 'Hi' }, { type: 'text', text: 'There' }]) },
    { type: 'frame', name: 'Features', children: JSON.stringify([{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }, { type: 'text', text: 'C' }]) },
  ]),
};
const spec1 = extractSpecJson(JSON.stringify(stringified));
check('stringified-children parses', !!spec1);
const count = (n: any): number => {
  let c = 1;
  if (Array.isArray(n?.children)) for (const k of n.children) c += count(k);
  return c;
};
check('stringified-children full count (>=8)', spec1 ? count(spec1) >= 8 : false, spec1 ? `count=${count(spec1)}` : undefined);

// 2. Normal array children still fine
const normal = { spec: { type: 'frame', children: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } };
const spec2 = extractSpecJson(JSON.stringify(normal));
check('normal-array parses', !!spec2 && count(spec2) === 3);

// 3. Fenced output with string children
const fenced = '```json\n' + JSON.stringify({ type: 'frame', children: JSON.stringify([{ type: 'text', text: 'x' }, { type: 'text', text: 'y' }, { type: 'text', text: 'z' }]) }) + '\n```';
const spec3 = extractSpecJson(fenced);
check('fenced string-children parses', !!spec3 && count(spec3!) >= 4, spec3 ? `count=${count(spec3)}` : undefined);

// 4. Garbage children string is dropped, not fatal
const garbage = { type: 'frame', children: 'not json', other: 1 };
const spec4 = extractSpecJson(JSON.stringify(garbage));
check('garbage-children dropped but root kept', !!spec4 && !('children' in (spec4 as any)));

// 5. Non-JSON prose → null (unchanged behavior)
check('prose returns null', extractSpecJson('I cannot produce JSON today, sorry') === null);

// 6. THE LIVE KILLER: unquoted keys inside nested objects (qwen3.7-plus,
// observed 3× in the 14:15 turn). JSON.parse fails; loose repair must save it.
const liveBroken = `{"direction":"Modern SaaS","spec":{"type":"frame","name":"LandingPage","width":"fill_container","height":"fit_content","fill":"#ffffff","autoLayout":{direction:"vertical",gap:0,padding:0},"children":[{"type":"frame","name":"Hero",'autoLayout':{direction:'horizontal',gap:24,},'children':[{"type":"text",'text':"Hello, world: {brace, test}"}]}]}}`;
const spec6 = extractSpecJson(liveBroken);
check('unquoted-keys + single-quotes + trailing-comma parses', !!spec6, spec6 ? JSON.stringify(spec6).slice(0, 120) : undefined);
check('live sample nested content intact', !!spec6 && count(spec6!) === 3, spec6 ? `count=${count(spec6)}` : undefined);

// 7. Content containing braces/commas/colons INSIDE strings is untouched
const tricky = `{"spec":{"type":"text","text":"Hello, world: {brace, test}","children":[]}}`;
const spec7 = extractSpecJson(tricky);
check('string content preserved', !!spec7 && (spec7 as any).text === 'Hello, world: {brace, test}');

// 8. Trailing commas in arrays
const trailing = `{"spec":{"type":"frame","children":[{"type":"text","text":"a"},]}}`;
const spec8 = extractSpecJson(trailing);
check('trailing comma repaired', !!spec8 && count(spec8!) === 2);

console.log(failures === 0 ? 'ALL PROBES PASSED' : `${failures} PROBE FAILURES`);
process.exit(failures === 0 ? 0 : 1);
