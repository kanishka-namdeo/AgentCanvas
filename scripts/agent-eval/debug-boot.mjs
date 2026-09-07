// debug-boot.mjs — why didn't the composer render for ?doc=verify-e2e-…
import { chromium } from 'playwright';

const BASE = 'http://localhost:81';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || m.type() === 'warning') console.log(`[C-${m.type()}] ${t.slice(0, 300)}`);
});
page.on('pageerror', (e) => console.log(`[PAGEERROR] ${String(e).slice(0, 300)}`));

await page.goto(`${BASE}/?doc=verify-e2e-xyz`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => console.log('goto:', e.message));
await page.waitForTimeout(8000);

console.log('TITLE:', await page.title());
console.log('TEXTAREAS:', await page.locator('textarea').count());
console.log('BUTTONS:', await page.locator('button').count());
const body = await page.evaluate(() => document.body.innerText.slice(0, 600));
console.log('BODY:', JSON.stringify(body));
await page.screenshot({ path: '/home/z/my-project/download/browser-verify/debug-boot.png' });
await browser.close();
