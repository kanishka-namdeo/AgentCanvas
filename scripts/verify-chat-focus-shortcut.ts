// Verify the `/` keyboard shortcut focuses the chat input.
// Also verifies the right panel auto-switches to Chat when `/` is pressed
// from the Design tab.

import { chromium } from 'playwright-core';

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

  // 1. Confirm default right tab is Design
  const designTabActive = await page.locator('button[role="tab"]:has-text("Design")').first().getAttribute('aria-selected');
  console.log('[1] Default right tab aria-selected (Design expected):', designTabActive);

  // 2. Press `/` (no modifier) and verify the chat input gets focused
  await page.keyboard.press('/');
  await page.waitForTimeout(300); // allow tab switch + focus

  // 3. The right panel should now be on Chat
  const chatTabActive = await page.locator('button[role="tab"]:has-text("Chat")').first().getAttribute('aria-selected');
  console.log('[2] After `/` press, Chat tab aria-selected (true expected):', chatTabActive);

  // 4. Check that a textarea is focused
  const activeEl = await page.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName ?? '',
      isTextarea: el?.tagName === 'TEXTAREA',
      placeholder: (el as HTMLTextAreaElement | null)?.placeholder ?? '',
    };
  });
  console.log('[3] Active element after `/`:', JSON.stringify(activeEl));

  // 5. Type something to confirm focus is real
  await page.keyboard.type('test prompt');
  await page.waitForTimeout(200);
  const textareaValue = await page.locator('textarea').first().inputValue().catch(() => '');
  console.log('[4] Textarea value after typing (expected "test prompt"):', JSON.stringify(textareaValue));

  if (designTabActive === 'true' && chatTabActive === 'true' && activeEl.isTextarea && textareaValue === 'test prompt') {
    console.log('\nALL CHAT-FOCUS SHORTCUT CHECKS PASSED');
  } else {
    console.log('\nFAIL — see above');
    process.exit(1);
  }

  await browser.close();
}

main().catch((err) => {
  console.error('CHAT-FOCUS VERIFY FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
