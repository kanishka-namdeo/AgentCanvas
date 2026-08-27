// debug-classifier.ts — print per-category matched keywords for a prompt.
import { SKILLS } from '../../src/lib/agent/skills/registry';

const prompt = process.argv[2] ?? "Create an 'Account Settings' panel with two labeled input fields: Display Name and Email Address.";
const lower = prompt.toLowerCase();

for (const [cat, skill] of Object.entries(SKILLS)) {
  if (!skill) continue;
  const matched: string[] = [];
  for (const kw of skill.keywords) {
    const k = kw.toLowerCase();
    const isShort = k.length <= 3;
    const m = isShort ? new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower) : lower.includes(k);
    if (m) matched.push(kw);
  }
  if (matched.length) console.log(`${cat.padEnd(12)}: ${matched.join(', ')}`);
}
