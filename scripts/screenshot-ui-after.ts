// Screenshot script — uses Playwright (already in node_modules via Next deps).
// Captures the polished UI from a stable URL.

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const OUT_DIR = '/home/z/my-project/download/ui-polish-after';
fs.mkdirSync(OUT_DIR, { recursive: true });

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  const url = 'http://127.0.0.1:3000/';
  console.log('→ navigating to', url);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  // Give React + Zustand hydration a beat.
  await page.waitForTimeout(2500);

  // 1) Full viewport — initial state
  await page.screenshot({ path: path.join(OUT_DIR, '01-initial.png'), fullPage: false });
  console.log('✓ 01-initial.png');

  // 2) Hover a session row in sidebar to reveal context menu trigger
  const sessionRow = await page.locator('[class*="ac-active-row"], [class*="cursor-pointer"]').first();
  if (sessionRow) await sessionRow.hover().catch(() => {});
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, '02-hover-session.png'), fullPage: false });
  console.log('✓ 02-hover-session.png');

  // 3) Click into the agent input so the grouped Send button is visible
  const textarea = page.locator('textarea').first();
  if (textarea) {
    await textarea.click().catch(() => {});
    await textarea.fill('Design a mobile login screen').catch(() => {});
  }
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, '03-input-focused.png'), fullPage: false });
  console.log('✓ 03-input-focused.png');

  // 4) Switch to snapshots tab in run history
  const snapTab = page.getByRole('button', { name: /Snapshots/ }).first();
  if (snapTab) await snapTab.click().catch(() => {});
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, '04-snapshots-tab.png'), fullPage: false });
  console.log('✓ 04-snapshots-tab.png');

  // 5) Switch back to runs tab and expand the first run (if any)
  const runsTab = page.getByRole('button', { name: /^Runs/ }).first();
  if (runsTab) await runsTab.click().catch(() => {});
  await page.waitForTimeout(200);
  const firstRun = page.locator('button:has-text("Design")').first();
  if (firstRun) await firstRun.click().catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT_DIR, '05-runs-expanded.png'), fullPage: false });
  console.log('✓ 05-runs-expanded.png');

  await browser.close();
  console.log('\nAll screenshots saved to', OUT_DIR);
}

main().catch((e) => {
  console.error('Screenshot script failed:', e);
  process.exit(1);
});
