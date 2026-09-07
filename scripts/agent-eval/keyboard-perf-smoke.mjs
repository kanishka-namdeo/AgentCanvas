// keyboard-perf-smoke.mjs — browser smoke for the 2026-09-08 key-repeat
// coalescing work (12-d #12).
//
// Clicking a canvas node selects its ROOT FRAME (text children are
// pointer-events:none — the click passes through), so the measured element is
// the frame, whose world-space `left` changes with the nudge (children keep
// their parent-relative offsets).
//
// Verifies:
//   1. 3 ArrowLeft keydowns dispatched in ONE task coalesce into a single
//      update_many with dx = -3 (frame moves -3px, ONE undo entry).
//   2. ⌘Z reverts the whole coalesced burst (snapshot-pool promote path).
//   3. ⌘⇧Z re-applies it (redo promote path).
// Usage: node scripts/agent-eval/keyboard-perf-smoke.mjs [docId]
import { chromium } from 'playwright';

const BASE = process.env.PROBE_URL || 'http://localhost:81';
const DOC_ID = process.argv[2] || 'demo';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`[CONSOLE-ERR] ${m.text().slice(0, 160)}`);
});
page.on('pageerror', (e) => console.log(`[PAGEERROR] ${String(e).slice(0, 200)}`));

await page.goto(`${BASE}/?doc=${DOC_ID}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
const node = page.locator('[data-node-type="text"]').first();
await node.waitFor({ state: 'visible', timeout: 30_000 });
await page.waitForTimeout(1500);

// Select (click passes through text children → selects the root frame).
await node.click();
await page.waitForTimeout(600);

const frameLeft = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-node-type="frame"]') ?? document.querySelector('[data-node-id]');
    return el ? parseFloat(el.style.left) : NaN;
  });

const before = await frameLeft();
const selection = await page.evaluate(
  () => document.querySelector('[data-chrome-selection]')?.getAttribute('data-chrome-selection') ?? null,
);
console.log(`selected=${selection} frame left before: ${before}px`);

// 3 ArrowLeft keydowns in one task → ONE rAF-coalesced update_many (-3px).
await page.evaluate(() => {
  for (let i = 0; i < 3; i++) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  }
});
await page.waitForTimeout(900);
const afterNudge = await frameLeft();
console.log(`after 3 coalesced ArrowLeft: ${afterNudge}px (expect ${before - 3}px)`);
const nudgeOk = Math.abs(afterNudge - (before - 3)) < 0.51;

// One ⌘Z reverts the whole coalesced burst (stripped snapshot rehydrates).
await page.evaluate(() =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true })),
);
await page.waitForTimeout(900);
const afterUndo = await frameLeft();
console.log(`after ⌘Z undo: ${afterUndo}px (expect ${before}px)`);
const undoOk = Math.abs(afterUndo - before) < 0.51;

// ⌘⇧Z redo re-applies it.
await page.evaluate(() =>
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true, bubbles: true }),
  ),
);
await page.waitForTimeout(900);
const afterRedo = await frameLeft();
console.log(`after ⌘⇧Z redo: ${afterRedo}px (expect ${before - 3}px)`);
const redoOk = Math.abs(afterRedo - (before - 3)) < 0.51;

await page.screenshot({ path: '/home/z/my-project/download/browser-verify/keyboard-perf-smoke.png' });
await browser.close();

const ok = nudgeOk && undoOk && redoOk;
console.log(ok ? '=== KEYBOARD PERF SMOKE: PASS ===' : '=== KEYBOARD PERF SMOKE: FAIL ===');
process.exit(ok ? 0 : 1);
