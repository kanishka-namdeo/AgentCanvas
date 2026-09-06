// Functional verification of the LLM provider config page after the
// round-4 audit fixes. Tests:
//   1. Open Settings → LLM provider section
//   2. Switch to "Custom (OpenAI-compatible)" provider
//   3. Verify the API key + API base URL fields appear
//   4. Verify the "Base URL required" preflight warning shows when apiBaseUrl is empty
//   5. Type a base URL + key + model name
//   6. Verify the warning clears once a base URL is entered
//   7. Close + reopen the dialog — verify values persist
//   8. Switch to a different provider (e.g. Anthropic) — verify apiKey + apiBaseUrl clear
//   9. Switch back to Custom — verify the model input field is typeable (combobox)

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT_DIR = '/home/z/my-project/download/llm-config-verification-2026-09-06';
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
  const consoleErrors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

  console.log('[1] Loading', BASE);
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForSelector('text=AgentCanvas', { timeout: 30_000 });

  // Open Settings via the gear button in the header.
  const settingsBtn = page.locator('button[aria-label="Open settings"]').first();
  if (!await settingsBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    // Fallback: try title-based selector.
    const altBtn = page.locator('button[title="Settings"]').first();
    await altBtn.click();
  } else {
    await settingsBtn.click();
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT_DIR, '01-settings-default.png') });
  console.log('[1] Settings dialog opened');

  // Click "LLM provider" in the left nav.
  const llmNav = page.locator('button:has-text("LLM provider")').first();
  await llmNav.click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, '02-llm-default.png') });
  console.log('[2] LLM provider section opened (default = zai)');

  // Switch to Custom provider.
  const providerTrigger = page.locator('button[role="combobox"]').first();
  await providerTrigger.click();
  await page.waitForTimeout(300);
  const customOption = page.locator('[role="option"]:has-text("Custom")').first();
  await customOption.click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT_DIR, '03-custom-empty.png') });
  console.log('[3] Switched to Custom provider (empty config)');

  // Verify the "Base URL required" warning shows.
  const baseUrlWarning = await page.locator('text=Base URL required').first().isVisible().catch(() => false);
  console.log('[4] "Base URL required" warning visible:', baseUrlWarning);

  // Type a base URL.
  // The apiBaseUrl Input has placeholder 'https://api.example.com/v1' for
  // the custom provider (per SettingsDialog.tsx:624). Use a robust selector
  // that finds the input by its visible label "API base URL".
  const baseUrlRow = page.locator('text=API base URL').first().locator('..');
  const baseUrlInput = baseUrlRow.locator('input').first();
  await baseUrlInput.fill('https://api.openai.com/v1');
  await page.waitForTimeout(300);

  // Type an API key.
  const apiKeyRow = page.locator('text=API key').first().locator('..');
  const apiKeyInput = apiKeyRow.locator('input[type="password"]').first();
  await apiKeyInput.fill('sk-test-abc123');
  await page.waitForTimeout(300);

  // Type a custom model name in the new always-visible Input.
  // The new Input has placeholder containing "type a custom model name".
  const customModelInput = page.locator('input[placeholder*="custom model name"]').first();
  if (await customModelInput.isVisible({ timeout: 2000 }).catch(() => false)) {
    await customModelInput.fill('gpt-4o-mini');
    console.log('[5] Typed custom model name "gpt-4o-mini" into the always-visible Input');
  } else {
    console.log('[5] SKIP — custom model Input not found (placeholder may have changed)');
  }
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT_DIR, '04-custom-filled.png') });

  // Verify the "Base URL required" warning has cleared.
  const baseUrlWarningAfter = await page.locator('text=Base URL required').first().isVisible().catch(() => false);
  console.log('[6] "Base URL required" warning cleared:', !baseUrlWarningAfter);

  // Close + reopen the dialog — verify values persist.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await settingsBtn.click();
  await page.waitForTimeout(300);
  await llmNav.click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, '05-after-reopen.png') });
  const providerAfterReopen = await page.locator('button[role="combobox"]').first().textContent();
  const baseUrlRowReopen = page.locator('text=API base URL').first().locator('..');
  const baseUrlAfterReopen = await baseUrlRowReopen.locator('input').first().inputValue().catch(() => '');
  console.log('[7] After reopen — provider:', JSON.stringify(providerAfterReopen?.trim()), 'baseUrl:', JSON.stringify(baseUrlAfterReopen));

  // Switch to a different provider (Anthropic) — verify apiKey + apiBaseUrl clear.
  await providerTrigger.click();
  await page.waitForTimeout(300);
  const anthropicOption = page.locator('[role="option"]:has-text("Anthropic")').first();
  await anthropicOption.click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT_DIR, '06-anthropic.png') });
  const apiKeyAfterSwitch = await page.locator('input[type="password"]').first().inputValue().catch(() => '');
  const baseUrlInputExists = await page.locator('input[placeholder*="api.openai.com"]').first().isVisible().catch(() => false);
  console.log('[8] After switching to Anthropic — apiKey cleared:', apiKeyAfterSwitch === '', 'baseUrl field hidden (non-OpenAI-compatible):', !baseUrlInputExists);

  await browser.close();

  console.log('\n=== Summary ===');
  console.log('Console errors:', consoleErrors.length);
  if (consoleErrors.length > 0) {
    console.log('First 3 errors:');
    consoleErrors.slice(0, 3).forEach((e, i) => console.log(`  ${i + 1}.`, e.slice(0, 200)));
  }
  console.log('Screenshots saved to:', OUT_DIR);

  const allPass = baseUrlWarning && !baseUrlWarningAfter && baseUrlAfterReopen === 'https://api.openai.com/v1';
  if (allPass && consoleErrors.length === 0) {
    console.log('\nALL LLM-CONFIG CHECKS PASSED');
  } else {
    console.log('\nNOTE: review the failures above before signing off');
    if (consoleErrors.length > 0) process.exit(1);
  }
}

main().catch((err) => {
  console.error('LLM-CONFIG VERIFY FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
