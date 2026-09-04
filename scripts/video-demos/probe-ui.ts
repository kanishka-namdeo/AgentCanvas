import { chromium } from 'playwright-core';

const CHROME = '/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome';

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(3000);

  console.log('=== BUTTONS (text content, first 40) ===');
  const buttons = await page.locator('button').allTextContents();
  console.log(buttons.filter(b => b.trim()).slice(0, 40).map((b, i) => `${i}: "${b.trim().slice(0, 60)}"`).join('\n'));

  console.log('\n=== ARIA labels on icon-only buttons ===');
  const labels = await page.locator('button[aria-label]').evaluateAll(els => els.map(e => e.getAttribute('aria-label')).filter(Boolean));
  console.log(labels.slice(0, 30).join(' | '));

  console.log('\n=== TEXTAREA count ===');
  console.log(await page.locator('textarea').count());

  console.log('\n=== Sidebar (aside) text (first 600 chars) ===');
  const sb = await page.locator('aside').first().innerText().catch(() => 'no aside');
  console.log(sb.slice(0, 600));

  console.log('\n=== Theme toggle search ===');
  const tt = page.locator('button[aria-label*="theme" i], button[aria-label*="dark" i], button[aria-label*="light" i], button[aria-label*="sun" i], button[aria-label*="moon" i]');
  console.log('theme toggle count:', await tt.count());

  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
