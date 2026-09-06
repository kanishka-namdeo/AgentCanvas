// Targeted theme-toggle verification — clicks the actual theme toggle
// button (aria-label="Toggle color theme") and cycles through all 3 modes
// (system → light → dark → system). Verifies the .dark class is actually
// applied to <html> when expected.

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT_DIR = '/home/z/my-project/download/upgrade-verification-2026-09-06';
mkdirSync(OUT_DIR, { recursive: true });
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/home/z/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
  });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForSelector('text=AgentCanvas', { timeout: 30_000 });

  // Find the theme toggle button by aria-label
  const themeBtn = page.locator('button[aria-label="Toggle color theme"]').first();
  const visible = await themeBtn.isVisible({ timeout: 5000 }).catch(() => false);
  console.log('[1] Theme toggle button visible:', visible);
  if (!visible) {
    console.log('[1] FAIL — theme toggle button not found');
    await browser.close();
    process.exit(1);
  }

  // Capture initial state
  let cls = await page.evaluate(() => document.documentElement.className);
  let bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  console.log('[2] Initial state: <html> class=' + JSON.stringify(cls) + ' body-bg=' + bg);

  // Click 1: system → light (no .dark class expected)
  await themeBtn.click();
  await page.waitForTimeout(400);
  cls = await page.evaluate(() => document.documentElement.className);
  bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  console.log('[3] After click 1 (system→light): <html> class=' + JSON.stringify(cls) + ' body-bg=' + bg);

  // Click 2: light → dark (.dark class expected)
  await themeBtn.click();
  await page.waitForTimeout(400);
  cls = await page.evaluate(() => document.documentElement.className);
  bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const hasDark = cls.includes('dark');
  console.log('[4] After click 2 (light→dark): <html> class=' + JSON.stringify(cls) + ' body-bg=' + bg + ' hasDark=' + hasDark);
  await page.screenshot({ path: path.join(OUT_DIR, '07-dark-mode-confirmed.png') });
  console.log('[4] Screenshot saved: 07-dark-mode-confirmed.png');

  // Click 3: dark → system (back to no .dark class with colorScheme=light)
  await themeBtn.click();
  await page.waitForTimeout(400);
  cls = await page.evaluate(() => document.documentElement.className);
  bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  console.log('[5] After click 3 (dark→system): <html> class=' + JSON.stringify(cls) + ' body-bg=' + bg);

  if (hasDark) {
    console.log('\nALL THEME CHECKS PASSED — dark mode was correctly applied on click 2');
  } else {
    console.log('\nFAIL — dark mode was NOT applied after clicking the toggle twice');
    process.exit(1);
  }

  await browser.close();
}

main().catch((err) => {
  console.error('THEME VERIFY FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
