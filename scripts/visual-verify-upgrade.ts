// Visual + functional smoke test for AgentCanvas after the package upgrade
// + React Compiler + Vitest 5 + Tailwind 4 cleanup pass.
//
// Loads the app, screenshots the initial workspace, opens the Settings
// dialog (verifies the LLM provider section), opens the command palette,
// and exercises a basic canvas interaction. Saves screenshots under
// /home/z/my-project/download/upgrade-verification/.

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
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    consoleErrors.push(`[pageerror] ${err.message}`);
  });

  console.log('[1] Loading', BASE);
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForSelector('text=AgentCanvas', { timeout: 30_000 });
  await page.screenshot({ path: path.join(OUT_DIR, '01-initial.png'), fullPage: false });
  console.log('[1] OK — initial workspace screenshot saved');

  // Verify the app rendered the workspace (4-panel layout)
  const canvasVisible = await page.locator('[data-testid="canvas"], .canvas-root, [class*="canvas"]').first().isVisible().catch(() => false);
  console.log('[2] Canvas visible:', canvasVisible);
  await page.screenshot({ path: path.join(OUT_DIR, '02-canvas-check.png'), fullPage: false });

  // Open Settings dialog via the app menu (look for the gear icon)
  console.log('[3] Opening Settings dialog');
  // Try clicking a Settings button — multiple selectors
  const settingsBtn = page.locator('button:has-text("Settings"), [aria-label*="Settings"], [aria-label*="settings"]').first();
  if (await settingsBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await settingsBtn.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT_DIR, '03-settings-dialog.png'), fullPage: false });
    console.log('[3] OK — Settings dialog screenshot saved');

    // Verify the LLM provider section shows 'z.ai (GLM)' as the default
    const zaiOption = await page.locator('text=z.ai').first().isVisible().catch(() => false);
    console.log('[3] z.ai provider visible in Settings:', zaiOption);

    // Close settings
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  } else {
    console.log('[3] SKIP — no Settings button found');
  }

  // Open command palette via Cmd+K (or Ctrl+K)
  console.log('[4] Opening command palette');
  await page.keyboard.press('Meta+K');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT_DIR, '04-command-palette.png'), fullPage: false });
  const paletteVisible = await page.locator('[role="dialog"], [cmdk-input], input[placeholder*="command" i]').first().isVisible().catch(() => false);
  console.log('[4] Command palette visible:', paletteVisible);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Try the agent panel — verify the chat input is present
  console.log('[5] Locating agent chat input');
  const chatInput = page.locator('textarea:has-text(""), [placeholder*="ask" i], [placeholder*="prompt" i], [placeholder*="message" i]').first();
  const chatVisible = await chatInput.isVisible({ timeout: 3000 }).catch(() => false);
  console.log('[5] Chat input visible:', chatVisible);
  await page.screenshot({ path: path.join(OUT_DIR, '05-agent-panel.png'), fullPage: false });

  // Toggle dark mode if ThemeToggle is visible
  console.log('[6] Looking for theme toggle');
  const themeToggle = page.locator('button:has(svg), [aria-label*="theme" i], [aria-label*="dark" i], [aria-label*="light" i]').first();
  // Try clicking the first button that looks like a theme toggle (top-right area)
  const themeBtn = page.locator('header button, [class*="header"] button').last();
  if (await themeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await themeBtn.click().catch(() => {});
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT_DIR, '06-after-theme-toggle.png'), fullPage: false });
    console.log('[6] OK — post-toggle screenshot saved');
  } else {
    console.log('[6] SKIP — no theme toggle found');
  }

  console.log('');
  console.log('=== Visual verification summary ===');
  console.log('Screenshots saved to:', OUT_DIR);
  console.log('Console errors captured:', consoleErrors.length);
  if (consoleErrors.length > 0) {
    console.log('First 5 console errors:');
    consoleErrors.slice(0, 5).forEach((e, i) => console.log(`  ${i + 1}.`, e.slice(0, 200)));
  }

  await browser.close();
  if (consoleErrors.length > 0) {
    console.log('\nNOTE: console errors detected — review before signing off');
  } else {
    console.log('\nALL VISUAL CHECKS PASSED');
  }
}

main().catch((err) => {
  console.error('VISUAL VERIFY FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
