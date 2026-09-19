// probe-vars.ts — diagnostic: which shape properties actually reference
// live CSS vars after patch normalization? Dump computed styles before and
// after a pack swap.
// Run: bunx tsx scripts/video-capture/probe-vars.ts
import { chromium } from 'playwright-core';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addInitScript(`(() => {
    localStorage.setItem('agentcanvas.settings.v1', JSON.stringify({ state: { themePreference: 'light' }, version: 5 }));
    localStorage.setItem('agentcanvas.onboarding.v1', JSON.stringify({ state: { hasCompleted: true, skipped: true }, version: 1 }));
    localStorage.setItem('design-systems:active-pack', 'shadcn-default');
  })()`);
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:3100/app?doc=probe-vars-1', { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('[aria-label="Canvas toolbar"]', { timeout: 90_000 });
  await page.waitForTimeout(2500);

  // Add a token-bound button frame.
  await page.evaluate(() => {
    const s = (window as unknown as { __canvasStore: { getState: () => { sendPatch: (p: unknown) => boolean } } }).__canvasStore.getState();
    s.sendPatch({
      op: 'add_subtree',
      shapeId: 'probe-btn',
      shape: {
        type: 'frame', name: 'Primary button', x: 300, y: 200, width: 172, height: 44,
        fill: 'var(--color-accent)', radius: 'var(--radius-md)',
        children: [{ type: 'text', name: 'label', x: 0, y: 12, width: 172, height: 20, text: 'Use this pack', fill: 'var(--color-accent-fg)', fontSize: 14, fontWeight: 600 }],
      },
      summary: 'probe button',
    });
    return true;
  });
  await page.waitForTimeout(1000);

  const dump = () => page.evaluate(() => {
    const el = document.querySelector('[data-node-id="probe-btn"]') as HTMLElement | null;
    if (!el) return { found: false };
    const cs = getComputedStyle(el);
    const label = el.querySelector('[data-node-id]') as HTMLElement | null;
    return {
      found: true,
      background: cs.background.slice(0, 60),
      backgroundColor: cs.backgroundColor,
      borderRadius: cs.borderRadius,
      labelColor: label ? getComputedStyle(label).color : null,
    };
  });
  console.log('shadcn:', JSON.stringify(await dump()));

  // Swap to geist.
  await page.evaluate(() => {
    localStorage.setItem('design-systems:active-pack', 'vercel-geist');
    window.dispatchEvent(new CustomEvent('design-system:change', { detail: { name: 'vercel-geist' } }));
    return true;
  });
  await page.waitForTimeout(2000);
  console.log('geist: ', JSON.stringify(await dump()));

  // Swap to mantine.
  await page.evaluate(() => {
    localStorage.setItem('design-systems:active-pack', 'mantine-default');
    window.dispatchEvent(new CustomEvent('design-system:change', { detail: { name: 'mantine-default' } }));
    return true;
  });
  await page.waitForTimeout(2000);
  console.log('mantine:', JSON.stringify(await dump()));
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
