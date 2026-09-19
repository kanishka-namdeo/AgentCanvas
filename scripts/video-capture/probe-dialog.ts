// probe-dialog.ts — diagnostic: what dialog blocks the app on a fresh context?
// Run: bunx tsx scripts/video-capture/probe-dialog.ts
import { chromium } from 'playwright-core';
import * as fs from 'fs';

async function main() {
  fs.mkdirSync('download/landing-capture/probe', { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addInitScript(`(() => {
    localStorage.setItem('agentcanvas.settings.v1', JSON.stringify({ state: { themePreference: 'light' }, version: 5 }));
    localStorage.setItem('agentcanvas.onboarding.v1', JSON.stringify({ state: { hasCompleted: true, skipped: true }, version: 1 }));
  })()`);
  const page = await ctx.newPage();
  page.on('console', (m) => console.log(`[console.${m.type()}]`, m.text().slice(0, 160)));
  await page.goto('http://127.0.0.1:3100/app?doc=probe-dialog-1', { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('[aria-label="Canvas toolbar"]', { timeout: 90_000 });
  await page.waitForTimeout(3000);

  const dialogs = await page.evaluate(() => {
    return [...document.querySelectorAll('[role="dialog"]')].map((d) => ({
      state: d.getAttribute('data-state'),
      labelledBy: d.getAttribute('aria-labelledby'),
      label: d.getAttribute('aria-label'),
      text: (d.textContent ?? '').slice(0, 300),
      html: d.innerHTML.slice(0, 600),
    }));
  });
  console.log(JSON.stringify(dialogs, null, 2));
  console.log('onboarding localStorage:', await page.evaluate(() => localStorage.getItem('agentcanvas.onboarding.v1')));
  console.log('settings localStorage:', await page.evaluate(() => localStorage.getItem('agentcanvas.settings.v1')));
  await page.screenshot({ path: 'download/landing-capture/probe/dialog.png' });
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
