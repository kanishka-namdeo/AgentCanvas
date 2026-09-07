// verify-persisted-canvas.mjs — reopen a doc URL in a FRESH browser context
// and count rendered [data-node-id] layers. Proves the agent's output
// persisted server-side and re-renders after a cold reload (no localStorage).
// Usage: node scripts/agent-eval/verify-persisted-canvas.mjs [docId]
import { chromium } from 'playwright';

const BASE = process.env.PROBE_URL || 'http://localhost:81';
const DOC_ID = process.argv[2] || 'demo';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`${BASE}/?doc=${DOC_ID}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

// Boot = REST fetch + canvas:full via WS. Poll for layers up to 30s.
let layerCount = 0;
let nodeTypes = {};
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000);
  layerCount = await page.evaluate(() => document.querySelectorAll('[data-node-id]').length);
  if (layerCount > 0) break;
}
nodeTypes = await page.evaluate(() => {
  const counts = {};
  for (const el of document.querySelectorAll('[data-node-type]')) {
    const t = el.getAttribute('data-node-type');
    counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
});
console.log(`doc=${DOC_ID} layerNodes=${layerCount} types=${JSON.stringify(nodeTypes)}`);
await page.screenshot({ path: '/home/z/my-project/download/browser-verify/persisted-reload.png' });
await browser.close();
process.exit(layerCount > 3 ? 0 : 1);
