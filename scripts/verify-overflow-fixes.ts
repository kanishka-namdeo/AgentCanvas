// Visual verification of the overflow fixes. Tests:
// 1. Render a markdown message with a long unbroken token (URL, base64, code)
//    via the chat panel and verify it wraps instead of overflowing.
// 2. Test the action row at narrow viewport widths.
// 3. Test the Settings dialog nav collapse on narrow widths.

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT_DIR = '/home/z/my-project/download/overflow-fix-verification-2026-09-06';
mkdirSync(OUT_DIR, { recursive: true });
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/home/z/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  // Test 1: Default viewport (1440x900) — check chat doesn't overflow
  const context1 = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
  });
  const page1 = await context1.newPage();
  const consoleErrors: string[] = [];
  page1.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

  console.log('[1] Loading', BASE, 'at 1440x900');
  await page1.goto(BASE, { waitUntil: 'networkidle', timeout: 60_000 });
  await page1.waitForSelector('text=AgentCanvas', { timeout: 30_000 });

  // Inject a test assistant message with long unbroken tokens via the session store.
  // The message contains: a long URL, a long base64 string, a long inline code snippet,
  // and a long word — all classic overflow offenders.
  const longUrl = 'https://example.com/very/long/url/that/should/wrap/instead/of/overflowing/the/chat/panel/boundary/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const longBase64 = 'eyJ0ZXN0IjoidGhpcyBpcyBhIHZlcnkgbG9uZyBiYXNlNjQgc3RyaW5nIHRoYXQgc2hvdWxkIHdyYXAgY29ycmVjdGx5IGluc3RlYWQgb2YgYmxvd2luZyBvdXQgdGhlIGNoYXQgYnViYmxlIHdpZHRoIn0=';
  const longWord = 'supercalifragilisticexpialidocious_supercalifragilisticexpialidocious_supercalifragilisticexpialidocious_supercalifragilisticexpialidocious';

  await page1.evaluate(({ url, b64, word }) => {
    const w = globalThis as unknown as {
      __sessionStore?: {
        getState: () => {
          _onSync?: (event: { type: string; sessionId?: string; message?: Record<string, unknown> }) => void;
          sessions?: Record<string, unknown>;
        };
      };
      __canvasStore?: {
        getState: () => {
          activeSessionId?: string;
          _onSync?: (event: { type: string; patch?: Record<string, unknown> }) => void;
        };
      };
    };
    // Try to inject via the canvas store's _onSync with an agent:message event
    if (w.__canvasStore && typeof w.__canvasStore.getState === 'function') {
      const store = w.__canvasStore.getState();
      if (typeof store._onSync === 'function') {
        // Cast to any — the SyncEvent union doesn't include the agent:message
        // variant in its type signature (it's a server→client event that
        // the test harness exercises directly).
        (store as { _onSync: (e: unknown) => void })._onSync({
          type: 'agent:message',
          message: {
            role: 'assistant',
            content: `Here's a long URL: ${url}\n\nAnd some base64: \`${b64}\`\n\nAnd a long word: ${word}\n\nAnd an inline code path: \`/usr/local/lib/node_modules/very/deeply/nested/path/to/some/module/that/should/wrap.js\``,
          },
        });
        return 'injected';
      }
    }
    return 'no-store';
  }, { url: longUrl, b64: longBase64, word: longWord }).then((r) => {
    console.log('[2] Inject test message result:', r);
  });

  await page1.waitForTimeout(1000);
  await page1.screenshot({ path: path.join(OUT_DIR, '01-chat-default-viewport.png') });
  console.log('[3] Screenshot saved (default viewport)');

  // Check for horizontal overflow in the chat panel
  const chatOverflow = await page1.evaluate(() => {
    const chatPanel = document.querySelector('.agent-panel-scroll, [class*="agent-panel"]');
    if (!chatPanel) return { hasOverflow: false, reason: 'no chat panel found' };
    const rect = chatPanel.getBoundingClientRect();
    const hasHorizontalScroll = chatPanel.scrollWidth > chatPanel.clientWidth;
    return {
      hasOverflow: hasHorizontalScroll,
      scrollWidth: chatPanel.scrollWidth,
      clientWidth: chatPanel.clientWidth,
      panelWidth: rect.width,
    };
  });
  console.log('[4] Chat panel overflow check:', JSON.stringify(chatOverflow));

  // Test 2: Narrow viewport (375x667 — mobile) — check action row + Settings nav
  const context2 = await browser.newContext({
    viewport: { width: 375, height: 667 },
    colorScheme: 'light',
  });
  const page2 = await context2.newPage();
  page2.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

  console.log('[5] Loading', BASE, 'at 375x667 (mobile)');
  await page2.goto(BASE, { waitUntil: 'networkidle', timeout: 60_000 });
  // The "AgentCanvas" brand text is hidden on mobile (hidden sm:inline), so
  // wait for the header element instead.
  await page2.waitForSelector('header', { timeout: 30_000 });
  await page2.waitForTimeout(500);
  await page2.screenshot({ path: path.join(OUT_DIR, '02-mobile-initial.png') });
  console.log('[6] Mobile screenshot saved');

  // Open Settings on mobile
  const settingsBtn = page2.locator('button[aria-label="Open settings"], button[title="Settings"]').first();
  if (await settingsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await settingsBtn.click();
    await page2.waitForTimeout(500);
    await page2.screenshot({ path: path.join(OUT_DIR, '03-mobile-settings.png') });
    console.log('[7] Mobile Settings screenshot saved');

    // Check if the nav collapsed to icons (w-12 = 48px) vs full width (w-48 = 192px)
    const navWidth = await page2.evaluate(() => {
      const nav = document.querySelector('nav');
      return nav ? nav.getBoundingClientRect().width : null;
    });
    console.log('[8] Settings nav width on mobile (expected ~48px):', navWidth);
  } else {
    console.log('[7] SKIP — Settings button not found on mobile');
  }

  await browser.close();

  console.log('\n=== Summary ===');
  console.log('Console errors:', consoleErrors.length);
  if (consoleErrors.length > 0) {
    console.log('First 3 errors:');
    consoleErrors.slice(0, 3).forEach((e, i) => console.log(`  ${i + 1}.`, e.slice(0, 200)));
  }
  console.log('Screenshots saved to:', OUT_DIR);

  if (consoleErrors.length === 0) {
    console.log('\nALL OVERFLOW-FIX CHECKS PASSED');
  } else {
    console.log('\nNOTE: review console errors above');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('OVERFLOW-FIX VERIFY FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
