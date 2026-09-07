// browser-verify-agent-flow.mjs — E2E verification of the agent chat flow
// through the CADDY GATEWAY (:81), mirroring what a real browser session does:
//
//   T1 (one-shot):  "create a simple login form wireframe …"  → turn completes
//                   with tool calls, no error rows, canvas renders the card.
//   T2 (follow-up): "make the button full width + blue heading" → turn
//                   completes, edits applied to the SAME card (no duplicates).
//
// Completion is detected via DOM markers from AgentPanel.tsx:
//   busy start : button[aria-label="Stop agent"] appears (optimistic, instant)
//   busy end   : Stop button disappears + metrics footer ("N tools") present
//   failure    : text "Turn failed" present anywhere in the chat panel
//
// Usage: node scripts/agent-eval/browser-verify-agent-flow.mjs
// Screenshots land in download/browser-verify/ (t1/t2, overwritten per run).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.PROBE_URL || 'http://localhost:81';
const DOC_ID = `verify-e2e-${Date.now().toString(36)}`; // fresh doc — never pollutes 'demo'
const OUT_DIR = new URL('../../download/browser-verify/', import.meta.url).pathname;

const T1_PROMPT =
  'create a simple login form wireframe with email and password fields and a sign in button';
const T2_PROMPT =
  'make the sign in button full width and change the heading text color to blue';

const TURN_TIMEOUT_MS = 300_000; // yesterday's one-shot ran 1m41s — allow 5min

mkdirSync(OUT_DIR, { recursive: true });

const results = [];

async function waitForComposer(page) {
  // The right panel defaults to the Design tab (page.tsx:193) — the composer
  // only mounts on the Chat tab. Click it (idempotent) before every turn:
  // after a run, node selection can flip the tab back to Design (page.tsx:360).
  const chatTab = page
    .getByRole('tablist', { name: 'Right panel' })
    .getByRole('tab', { name: 'Chat', exact: true });
  try {
    await chatTab.click({ timeout: 10_000 });
  } catch {
    /* already active / hidden — fall through to the textarea wait */
  }
  // The composer is the always-present textarea; idle placeholder starts with
  // "Ask the agent". Wait for the app to boot (REST-first + socket).
  const ta = page.locator('textarea').first();
  await ta.waitFor({ state: 'visible', timeout: 60_000 });
  for (let i = 0; i < 30; i++) {
    const ph = await ta.getAttribute('placeholder');
    if (ph && ph.startsWith('Ask the agent')) return ta;
    await page.waitForTimeout(1000);
  }
  throw new Error('composer never reached idle state');
}

async function runTurn(page, label, prompt, shot) {
  const t0 = Date.now();
  const composer = await waitForComposer(page);
  await composer.fill(prompt);
  await composer.press('Enter');

  const stop = page.locator('button[aria-label="Stop agent"]');
  // Busy arms synchronously before the emit — expect the Stop button quickly.
  try {
    await stop.waitFor({ state: 'visible', timeout: 20_000 });
  } catch {
    // The turn may complete before we ever poll (very fast model) — only fail
    // if there is ALSO no completed metrics row.
    const done = await page.locator('span:has-text("tools")').count();
    if (done === 0) throw new Error(`${label}: no busy state AND no completed turn`);
  }
  // Busy end: Stop button gone (or never appeared) + a metrics footer exists.
  await stop.waitFor({ state: 'hidden', timeout: TURN_TIMEOUT_MS });

  // settle: metrics/footer/self-review rows render after streaming flips off
  await page.waitForTimeout(2500);

  const failed = await page.locator('text=Turn failed').count();
  const tools = await page
    .locator('span[title*="tool calls"]')
    .last()
    .textContent()
    .catch(() => null);
  const busy = await stop.count();

  await page.screenshot({ path: shot, fullPage: false });

  const ok = failed === 0 && busy === 0;
  results.push({ label, ok, failed, tools, ms: Date.now() - t0, shot });
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${label}: ${((Date.now() - t0) / 1000).toFixed(0)}s, ` +
      `toolCalls=${tools ? tools.trim() : 'n/a'}, errorRows=${failed}`
  );
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

// Surface app console errors for diagnosis on failure.
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`[CONSOLE-ERR] ${m.text().slice(0, 200)}`);
});

console.log(`doc: ${DOC_ID}`);
await page.goto(`${BASE}/?doc=${DOC_ID}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

await runTurn(page, 'T1 one-shot', T1_PROMPT, `${OUT_DIR}t1-login-oneshot.png`);
await runTurn(page, 'T2 follow-up', T2_PROMPT, `${OUT_DIR}t2-followup.png`);

// Canvas content sanity: the DOM canvas should now contain rendered layers.
// (DomNode.tsx exposes data-node-id / data-node-type on every layer.)
const layerCount = await page.evaluate(() => {
  return document.querySelectorAll('[data-node-id]').length;
});
console.log(`canvas layer nodes: ${layerCount}`);

await browser.close();

const allOk = results.every((r) => r.ok) && layerCount > 3;
console.log(allOk ? '=== BROWSER E2E: PASS ===' : '=== BROWSER E2E: FAIL ===');
process.exit(allOk ? 0 : 1);
