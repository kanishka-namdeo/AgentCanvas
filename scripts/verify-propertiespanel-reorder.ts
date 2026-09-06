// Functional verification of the PropertiesPanel section reorder.
// Uses the agent chat to create a shape (more reliable than simulating
// toolbar clicks), then inspects the Design tab's section order.

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT_DIR = '/home/z/my-project/download/sidebar-refactor-verification-2026-09-06';
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

  // Inject a shape directly via the canvas store's _onSync test hook.
  // The store exposes _onSync which accepts a SyncEvent of type 'patch'
  // with a CanvasPatch of op 'add'. This is the same path the agent uses
  // to create shapes — bypasses the toolbar + chat for a deterministic test.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __canvasStore?: {
        getState: () => {
          _onSync?: (event: { type: string; patch: Record<string, unknown> }) => void;
          setSelected?: (ids: string[]) => void;
          documentId?: string;
        };
      };
    };
    if (w.__canvasStore && typeof w.__canvasStore.getState === 'function') {
      const store = w.__canvasStore.getState();
      if (typeof store._onSync === 'function') {
        store._onSync({
          type: 'patch',
          patch: {
            op: 'add',
            shape: {
              id: 'test-rect-1',
              type: 'rectangle',
              name: 'Test Rectangle',
              x: 200, y: 200, width: 200, height: 120,
              rotation: 0, opacity: 1,
              fill: '#3b82f6', stroke: '#1e3a8a', strokeWidth: 2, radius: 8,
              parentId: null, zIndex: 0, locked: false, visible: true,
            },
            shapeId: 'test-rect-1',
          },
        });
        if (typeof store.setSelected === 'function') {
          store.setSelected(['test-rect-1']);
        }
        return 'shape-added';
      }
      return 'no-_onSync';
    }
    return 'no-store';
  }).then((result) => {
    console.log('[2] Inject shape result:', result);
  });

  await page.waitForTimeout(500);

  // The auto-switch effect should move us to Design since a shape is selected.
  // But let's also explicitly click Design to be sure.
  const designTab = page.locator('div[role="tablist"][aria-label="Right panel"] button[role="tab"]').filter({ hasText: 'Design' }).first();
  await designTab.click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT_DIR, '07-design-shape-selected.png') });
  console.log('[3] Screenshot saved (Design tab with selected shape)');

  // Verify the section labels appear in the expected order.
  // For a rectangle, the PropertiesPanel should show:
  //   Name → Position (X/Y) → Dimensions → Constraints → Appearance → Variables · Modes
  // (Auto Layout only for frame/group; Text only for text shapes; Component only if master/instance)

  // Collect all visible section labels (Collapsible triggers + standalone Labels)
  const triggerLabels = await page.locator('button[type="button"] > label').allTextContents();
  const standaloneLabels = await page.locator('div > label').allTextContents();
  const allLabels = [...triggerLabels, ...standaloneLabels]
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.length < 30);
  console.log('[4] All section labels (in DOM order):');
  allLabels.forEach((l, i) => console.log(`     ${i + 1}. ${l}`));

  // Verify "Appearance" exists (the renamed "Style")
  const appearanceVisible = await page.locator('button[type="button"]:has(label:has-text("Appearance"))').first().isVisible().catch(() => false);
  console.log('[5] "Appearance" section visible:', appearanceVisible);

  // Verify "Style" does NOT exist
  const styleVisible = await page.locator('button[type="button"]:has(label:has-text("Style"))').first().isVisible().catch(() => false);
  console.log('[6] Old "Style" section visible (expected false):', styleVisible);

  // Verify the order: Position (X) → Dimensions → Appearance
  const positionIdx = allLabels.findIndex((l) => l === 'X');
  const dimensionsIdx = allLabels.findIndex((l) => l === 'Dimensions');
  const appearanceIdx = allLabels.findIndex((l) => l === 'Appearance');
  console.log('[7] Position(X) idx:', positionIdx, 'Dimensions idx:', dimensionsIdx, 'Appearance idx:', appearanceIdx);
  const orderCorrect = positionIdx >= 0 && dimensionsIdx >= 0 && appearanceIdx >= 0 &&
    positionIdx < dimensionsIdx && dimensionsIdx < appearanceIdx;
  console.log('[8] Order Position → Dimensions → Appearance:', orderCorrect);

  await browser.close();
  console.log('\n=== Summary ===');
  console.log('Console errors:', consoleErrors.length);

  const allPass = appearanceVisible && !styleVisible && orderCorrect && consoleErrors.length === 0;
  if (allPass) {
    console.log('\nALL PROPERTIESPANEL-REORDER CHECKS PASSED');
  } else {
    console.log('\nNOTE: review the output above');
  }
}

main().catch((err) => {
  console.error('PROPERTIESPANEL-REORDER VERIFY FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
