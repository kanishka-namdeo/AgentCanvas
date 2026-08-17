// Evaluation harness for the pi agent's intent classifier.
//
// This is Tier 1 of the research recommendations (see worklog.md, Task ID:
// assess-skills): a regression-style eval that runs the keyword classifier
// against 20 hand-labeled prompts covering all 7 skill categories plus
// multi-step prompts that should trigger a planning phase.
//
// Run with:  bun run scripts/eval-agent.ts
//
// Exit code:  0 if overall accuracy >= 80% (PASS),  1 otherwise (FAIL).
//
// Test design:
//   - 3 prompts each for wireframe / layout / styling / inspect
//   - 2 prompts each for export / web_research / vector
//   - 2 multi-step prompts (research+design, look-up+design)
//   - 2 prompts are deliberately chosen to expose known classifier gaps:
//       #12 "audit my design"          — "audit"(inspect) ties "design"(wireframe);
//                                         stable sort picks wireframe (first in
//                                         Object.entries(SKILLS) iteration).
//       #16 "what's new in Tailwind CSS" — "what's new" does NOT match the
//                                         web_research keyword "what is";
//                                         "tailwind" matches export instead.
//   These documented mismatches are intentional — the eval's job is to surface
//   real classifier weaknesses, not to game the accuracy number.

import { classifyIntent } from '../src/lib/agent/classifier';
import type { SkillCategory } from '../src/lib/agent/skills/types';

// ---- Test cases -----------------------------------------------------------
//
// Each test case has:
//   - prompt:                  the user input
//   - expectedCategory:        the SkillCategory the classifier should pick
//   - expectedRecommendPlan:   whether a planning phase should be recommended
//   - note:                    a brief explanation of why this is expected
//                              (and, for known gaps, why it currently fails)

interface TestCase {
  id: number;
  prompt: string;
  expectedCategory: SkillCategory;
  expectedRecommendPlan: boolean;
  note: string;
}

const TEST_CASES: TestCase[] = [
  // ---- wireframe (3) ------------------------------------------------------
  {
    id: 1,
    prompt: 'design a login screen',
    expectedCategory: 'wireframe',
    expectedRecommendPlan: false,
    note: 'Three wireframe keywords (design, login, screen). Unambiguous.',
  },
  {
    id: 2,
    prompt: 'build a dashboard',
    expectedCategory: 'wireframe',
    expectedRecommendPlan: false,
    note: 'Two wireframe keywords (build, dashboard). Unambiguous.',
  },
  {
    id: 3,
    prompt: 'make a landing page',
    expectedCategory: 'wireframe',
    expectedRecommendPlan: false,
    note: 'Three wireframe keywords (make, landing, page). Unambiguous.',
  },

  // ---- layout (3) ---------------------------------------------------------
  {
    id: 4,
    prompt: 'align these shapes',
    expectedCategory: 'layout',
    expectedRecommendPlan: false,
    note: 'Single layout keyword (align). No competing skill matches.',
  },
  {
    id: 5,
    prompt: 'organize my layers',
    expectedCategory: 'layout',
    expectedRecommendPlan: false,
    note: 'Two layout keywords (organize, layer via substring "layers").',
  },
  {
    id: 6,
    prompt: 'group these cards',
    expectedCategory: 'layout',
    expectedRecommendPlan: false,
    note: 'Single layout keyword (group). "cards" is not a keyword.',
  },

  // ---- styling (3) --------------------------------------------------------
  {
    id: 7,
    prompt: 'recolor everything blue',
    expectedCategory: 'styling',
    expectedRecommendPlan: false,
    note: 'Single styling keyword (recolor). "blue" is not a keyword.',
  },
  {
    id: 8,
    prompt: 'add a shadow',
    expectedCategory: 'styling',
    expectedRecommendPlan: false,
    note: 'Single styling keyword (shadow). Unambiguous.',
  },
  {
    id: 9,
    prompt: 'apply a warm palette',
    expectedCategory: 'styling',
    expectedRecommendPlan: false,
    note: 'KNOWN GAP: styling matches "palette" (+1), but wireframe matches "app" (+1) ' +
          'as a substring of "apply". Tied 1-1 → stable sort picks wireframe (first in ' +
          'Object.entries(SKILLS) order). Root cause: short keywords like "app", "ui", ' +
          '"web" match as substrings of unrelated words.',
  },

  // ---- inspect (3) --------------------------------------------------------
  {
    id: 10,
    prompt: 'what shapes are on the canvas',
    expectedCategory: 'inspect',
    expectedRecommendPlan: false,
    note: 'Multi-word inspect keyword "what shapes" (weighted +2). Unambiguous.',
  },
  {
    id: 11,
    prompt: 'list all variables and theme axes',
    expectedCategory: 'inspect',
    expectedRecommendPlan: false,
    note: 'Inspect keywords "list" + "variables". Maps to pen_list_themes (read-only inspect).',
  },
  {
    id: 12,
    prompt: 'audit my design',
    expectedCategory: 'inspect',
    expectedRecommendPlan: false,
    note: 'KNOWN GAP: "audit"(inspect, +1) ties "design"(wireframe, +1). Stable ' +
          'sort picks wireframe (first in Object.entries(SKILLS) order). The ' +
          'fix would be to either weight "audit" higher or add tie-breaking by ' +
          'keyword specificity.',
  },

  // ---- export (2) ---------------------------------------------------------
  {
    id: 13,
    prompt: 'export as SVG',
    expectedCategory: 'export',
    expectedRecommendPlan: false,
    note: 'Two export keywords (export, svg). Unambiguous.',
  },
  {
    id: 14,
    prompt: 'get the JSON',
    expectedCategory: 'export',
    expectedRecommendPlan: false,
    note: 'Single export keyword (json). Unambiguous.',
  },

  // ---- web_research (2) ---------------------------------------------------
  {
    id: 15,
    prompt: 'search for 2025 design trends',
    expectedCategory: 'web_research',
    expectedRecommendPlan: false,
    note: 'KNOWN GAP (plan over-trigger): web_research matches 4 keywords (search, 2025, ' +
          'trend, trends = +4) and dominates the category pick (correct). BUT the plan ' +
          'recommendation over-fires: the rule `(hasResearch && hasDesign)` is true ' +
          'because "design" appears as a wireframe keyword — even though here it is just ' +
          'the search topic, not a design request. Single-step research prompts should ' +
          'not trigger a plan.',
  },
  {
    id: 16,
    prompt: "what's new in Tailwind CSS",
    expectedCategory: 'web_research',
    expectedRecommendPlan: false,
    note: 'KNOWN GAP: "what\'s new" does NOT match the web_research keyword "what is" ' +
          '(apostrophe-vs-space mismatch). "tailwind" matches export, so the ' +
          'classifier returns export. The fix would be to add "what\'s new" or ' +
          '"whats new" as a web_research keyword, or to normalize apostrophes.',
  },

  // ---- vector (2) ---------------------------------------------------------
  {
    id: 17,
    prompt: 'draw a path',
    expectedCategory: 'vector',
    expectedRecommendPlan: false,
    note: 'Single vector keyword (path). Unambiguous.',
  },
  {
    id: 18,
    prompt: 'boolean union these shapes',
    expectedCategory: 'vector',
    expectedRecommendPlan: false,
    note: 'Two vector keywords (boolean, union). Unambiguous.',
  },

  // ---- multi-step (2) -----------------------------------------------------
  // For multi-step prompts, the "expected category" is the skill with the
  // highest keyword score (the classifier's primary pick). The plan flag is
  // expected to be true because both prompts combine web_research + wireframe
  // and contain a connective ("then" / "and").
  {
    id: 19,
    prompt: 'research design trends then build a dashboard',
    // For multi-step prompts, the primary category is the FINAL deliverable
    // (wireframe — to build the dashboard). The web_research part is dispatched
    // as a sub-agent automatically (see runner.ts needsWebResearch logic).
    expectedCategory: 'wireframe',
    expectedRecommendPlan: true,
    note: 'Multi-step: research → design. Primary skill is the final deliverable ' +
          '(wireframe). web_research is a secondary category, dispatched as a sub-agent.',
  },
  {
    id: 20,
    prompt: 'look up competitor pricing and design a pricing page',
    expectedCategory: 'wireframe',
    expectedRecommendPlan: true,
    note: 'wireframe (design, pricing, page = +3) beats web_research (look up = +2). ' +
          '"and" + research+design triggers recommendPlan.',
  },
];

// ---- Eval runner ----------------------------------------------------------

interface TestResult {
  test: TestCase;
  actualCategory: SkillCategory;
  actualRecommendPlan: boolean;
  secondaryCategories: SkillCategory[];
  method: string;
  confidence: number;
  categoryMatch: boolean;
  planMatch: boolean;
  pass: boolean;
  error?: string;
}

async function runEval(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const test of TEST_CASES) {
    try {
      const result = await classifyIntent({
        prompt: test.prompt,
        canvasShapeCount: 0,
        // No `llm` provided → keyword-only mode (per task spec).
      });
      const categoryMatch = result.category === test.expectedCategory;
      const planMatch = result.recommendPlan === test.expectedRecommendPlan;
      results.push({
        test,
        actualCategory: result.category,
        actualRecommendPlan: result.recommendPlan,
        secondaryCategories: result.secondaryCategories,
        method: result.method,
        confidence: result.confidence,
        categoryMatch,
        planMatch,
        pass: categoryMatch && planMatch,
      });
    } catch (e) {
      results.push({
        test,
        actualCategory: 'multi' as SkillCategory,
        actualRecommendPlan: false,
        secondaryCategories: [],
        method: 'error',
        confidence: 0,
        categoryMatch: false,
        planMatch: false,
        pass: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

// ---- Formatting helpers ---------------------------------------------------

function pad(s: string, len: number): string {
  // Pad/truncate a string to exactly `len` visible columns.
  if (s.length >= len) return s.slice(0, Math.max(0, len - 1)) + '…';
  return s + ' '.repeat(len - s.length);
}

function fmtPct(n: number, total: number): string {
  if (total === 0) return '0.0%';
  return ((n / total) * 100).toFixed(1) + '%';
}

// Visible width of a string (ignores combining marks; sufficient for ASCII table).
// Kept simple — all our cells are ASCII after truncation.

// ---- Main ------------------------------------------------------------------

async function main() {
  const W = 100; // table width for separator lines

  console.log('');
  console.log('═'.repeat(W));
  console.log('  PI AGENT INTENT CLASSIFIER — EVAL HARNESS');
  console.log('  Mode: keyword-only (no LLM fallback)');
  console.log(`  Test cases: ${TEST_CASES.length}  (3 wireframe, 3 layout, 3 styling,`);
  console.log('               3 inspect, 2 export, 2 web_research, 2 vector, 2 multi-step)');
  console.log('═'.repeat(W));
  console.log('');

  const results = await runEval();

  // ---- Detail table ------------------------------------------------------
  // Columns:
  //   #  | prompt | expected | actual | cat? | plan(exp) | plan(act) | plan? | conf | method
  const cols = {
    id: 3,
    prompt: 38,
    expected: 13,
    actual: 13,
    catOk: 4,
    planExp: 6,
    planAct: 6,
    planOk: 5,
    conf: 5,
    method: 8,
  };

  const sep = '  ';
  const header =
    pad('#', cols.id) + sep +
    pad('prompt', cols.prompt) + sep +
    pad('expected', cols.expected) + sep +
    pad('actual', cols.actual) + sep +
    pad('cat', cols.catOk) + sep +
    pad('planE', cols.planExp) + sep +
    pad('planA', cols.planAct) + sep +
    pad('plan', cols.planOk) + sep +
    pad('conf', cols.conf) + sep +
    pad('method', cols.method);

  console.log('  Detail');
  console.log('  ' + '─'.repeat(header.length));
  console.log('  ' + header);
  console.log('  ' + '─'.repeat(header.length));

  for (const r of results) {
    const line =
      pad(String(r.test.id), cols.id) + sep +
      pad(r.test.prompt, cols.prompt) + sep +
      pad(r.test.expectedCategory, cols.expected) + sep +
      pad(r.actualCategory, cols.actual) + sep +
      pad(r.categoryMatch ? '✓' : '✗', cols.catOk) + sep +
      pad(r.test.expectedRecommendPlan ? 'true' : 'false', cols.planExp) + sep +
      pad(r.actualRecommendPlan ? 'true' : 'false', cols.planAct) + sep +
      pad(r.planMatch ? '✓' : '✗', cols.planOk) + sep +
      pad(r.confidence.toFixed(2), cols.conf) + sep +
      pad(r.method, cols.method);
    console.log('  ' + line);
  }
  console.log('  ' + '─'.repeat(header.length));
  console.log('');

  // ---- Summary -----------------------------------------------------------
  const total = results.length;
  const categoryCorrect = results.filter((r) => r.categoryMatch).length;
  const planCorrect = results.filter((r) => r.planMatch).length;
  const overallPass = results.filter((r) => r.pass).length;
  const accuracy = overallPass / total;

  console.log('═'.repeat(W));
  console.log('  SUMMARY');
  console.log('═'.repeat(W));
  console.log(`  Category accuracy:  ${categoryCorrect}/${total}  (${fmtPct(categoryCorrect, total)})`);
  console.log(`  Plan accuracy:      ${planCorrect}/${total}  (${fmtPct(planCorrect, total)})`);
  console.log(`  Overall pass:       ${overallPass}/${total}  (${fmtPct(overallPass, total)})   ← both category AND plan must match`);
  console.log(`  Threshold:          80.0%`);
  console.log(`  Result:             ${accuracy >= 0.8 ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log('');

  // ---- Per-category breakdown --------------------------------------------
  console.log('═'.repeat(W));
  console.log('  PER-CATEGORY BREAKDOWN  (grouped by expected category)');
  console.log('═'.repeat(W));

  const byCategory: Record<string, { total: number; passed: number; mismatches: string[] }> = {};
  for (const r of results) {
    const cat = r.test.expectedCategory;
    if (!byCategory[cat]) byCategory[cat] = { total: 0, passed: 0, mismatches: [] };
    byCategory[cat].total += 1;
    if (r.pass) {
      byCategory[cat].passed += 1;
    } else {
      const parts: string[] = [];
      if (!r.categoryMatch) parts.push(`category=${r.actualCategory}`);
      if (!r.planMatch) parts.push(`plan=${r.actualRecommendPlan}`);
      byCategory[cat].mismatches.push(`#${r.test.id} "${r.test.prompt}" (${parts.join(', ')})`);
    }
  }

  // Print in the canonical skill order.
  const categoryOrder: SkillCategory[] = [
    'wireframe', 'layout', 'styling', 'inspect', 'export', 'web_research', 'vector', 'multi',
  ];
  console.log(`  ${pad('category', 14)}  ${pad('pass', 8)}  mismatches`);
  console.log(`  ${'─'.repeat(14)}  ${'─'.repeat(8)}  ${'─'.repeat(60)}`);
  for (const cat of categoryOrder) {
    const info = byCategory[cat];
    if (!info) continue;
    const mismatchStr = info.mismatches.length === 0 ? '—' : info.mismatches.join('; ');
    console.log(`  ${pad(cat, 14)}  ${pad(`${info.passed}/${info.total}`, 8)}  ${mismatchStr}`);
  }
  console.log('');

  // ---- Method + confidence breakdown -------------------------------------
  console.log('═'.repeat(W));
  console.log('  CLASSIFICATION METHOD BREAKDOWN');
  console.log('═'.repeat(W));
  const byMethod: Record<string, number> = {};
  for (const r of results) {
    byMethod[r.method] = (byMethod[r.method] || 0) + 1;
  }
  for (const [method, count] of Object.entries(byMethod)) {
    console.log(`  ${pad(method, 12)}  ${count}/${total}  (${fmtPct(count, total)})`);
  }
  console.log('');

  const confidences = results.map((r) => r.confidence);
  const avgConf = confidences.reduce((a, b) => a + b, 0) / confidences.length;
  const minConf = Math.min(...confidences);
  const maxConf = Math.max(...confidences);
  console.log(`  Confidence:  avg=${avgConf.toFixed(2)}  min=${minConf.toFixed(2)}  max=${maxConf.toFixed(2)}`);
  console.log('');

  // ---- Failed-test notes (call out known gaps) ---------------------------
  const failures = results.filter((r) => !r.pass);
  if (failures.length > 0) {
    console.log('═'.repeat(W));
    console.log('  FAILED TESTS — NOTES');
    console.log('═'.repeat(W));
    for (const r of failures) {
      console.log(`  #${r.test.id}  "${r.test.prompt}"`);
      console.log(`        expected: category=${r.test.expectedCategory}, plan=${r.test.expectedRecommendPlan}`);
      console.log(`        actual:   category=${r.actualCategory}, plan=${r.actualRecommendPlan}  (conf=${r.confidence.toFixed(2)}, method=${r.method})`);
      console.log(`        note:     ${r.test.note}`);
      if (r.secondaryCategories.length > 0) {
        console.log(`        secondary: ${r.secondaryCategories.join(', ')}`);
      }
      console.log('');
    }
  }

  // ---- Exit code ---------------------------------------------------------
  if (accuracy >= 0.8) {
    console.log(`✓ PASS — overall accuracy ${fmtPct(overallPass, total)} >= 80% threshold`);
    process.exit(0);
  } else {
    console.log(`✗ FAIL — overall accuracy ${fmtPct(overallPass, total)} < 80% threshold`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Eval harness crashed:', e);
  process.exit(2);
});
