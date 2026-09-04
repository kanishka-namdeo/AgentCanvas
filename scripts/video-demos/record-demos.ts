// record-demos.ts — programmatically record short video demos of AgentCanvas features.
//
// Strategy: Playwright's `recordVideo` context option captures a WebM of every
// interaction in that context. We open a fresh context per scene, drive real UI
// interactions (clicks, drags, typing, toggles), then close the context to
// finalize the WebM. A downstream ffmpeg pass converts each WebM into a small
// MP4 (for <video> embed) and a palette-optimized GIF (for guaranteed GitHub
// README rendering — GitHub's markdown does NOT render <video> tags with
// relative paths, but GIFs always render via ![alt](path) syntax).
//
// Reference: https://playwright.dev/docs/videos
//
// Run: bun run scripts/video-demos/record-demos.ts
//
// Prereqs:
//   - dev server on http://127.0.0.1:3000
//   - chromium at /home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome
//   - ffmpeg on PATH

import { chromium, type Browser, type Page } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';

const APP_URL = 'http://127.0.0.1:3000/';
const CHROME = '/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome';
const OUT_DIR = '/home/z/my-project/download/video-demos';

const VIEWPORT = { width: 1680, height: 1050 };

// Hard cap per scene (drive + tail). Keeps total runtime bounded.
const SCENE_BUDGET_MS = 25_000;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function waitReady(page: Page) {
  await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await sleep(2500);
}

async function clickByLabel(page: Page, label: string) {
  await page.locator(`button[aria-label="${label}"]`).first().click({ timeout: 5000 });
}

async function clickByText(page: Page, text: string) {
  await page.getByRole('button', { name: text }).first().click({ timeout: 5000 });
}

async function canvasCenter(page: Page) {
  const selectors = [
    '[data-ac-canvas]',
    '[class*="ac-canvas"]',
    '[class*="canvas-root"]',
    'main [role="presentation"]',
    'main',
  ];
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if ((await el.count()) > 0) {
      const box = await el.boundingBox();
      if (box && box.width > 200 && box.height > 200) {
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }
    }
  }
  return { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
}

// Open a fresh recording context for a scene, drive it, return the WebM path.
async function recordScene(
  browser: Browser,
  name: string,
  drive: (page: Page) => Promise<void>
): Promise<string> {
  console.log(`\n▶ scene: ${name}`);
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    recordVideo: { dir: OUT_DIR, size: VIEWPORT },
  });
  const page = await ctx.newPage();
  try {
    await waitReady(page);
    // Race the drive against a hard deadline; if it overruns, finalize anyway.
    await Promise.race([
      drive(page),
      sleep(SCENE_BUDGET_MS).then(() => {
        console.warn(`  ⚠ scene "${name}" hit ${SCENE_BUDGET_MS}ms budget, finalizing early`);
      }),
    ]);
    await sleep(900); // tail — let final state settle on screen
  } catch (e) {
    console.warn(`  ⚠ scene "${name}" error:`, (e as Error).message);
  } finally {
    const vid = await page.video();
    const tmpPath = await vid!.path();
    await ctx.close();
    const finalPath = path.join(OUT_DIR, `${name}.webm`);
    fs.renameSync(tmpPath, finalPath);
    console.log(`  ✓ ${finalPath} (${(fs.statSync(finalPath).size / 1024).toFixed(0)} KB)`);
    return finalPath;
  }
}

// --- Scenes ------------------------------------------------------------------

async function sceneShapeDrawing(page: Page) {
  const { x: cx, y: cy } = await canvasCenter(page);

  await clickByLabel(page, 'Add rectangle');
  await sleep(400);
  await page.mouse.move(cx - 220, cy - 80);
  await page.mouse.down();
  await page.mouse.move(cx - 60, cy + 60, { steps: 18 });
  await page.mouse.up();
  await sleep(500);

  await clickByLabel(page, 'Select tool');
  await sleep(150);
  await clickByLabel(page, 'Add ellipse');
  await sleep(400);
  await page.mouse.move(cx + 80, cy - 80);
  await page.mouse.down();
  await page.mouse.move(cx + 240, cy + 80, { steps: 18 });
  await page.mouse.up();
  await sleep(500);

  await clickByLabel(page, 'Add text');
  await sleep(400);
  await page.mouse.click(cx - 40, cy + 120);
  await sleep(300);
  await page.keyboard.type('AgentCanvas', { delay: 60 });
  await sleep(400);
  await page.mouse.click(cx, cy - 220);
  await sleep(500);
}

async function sceneLayersAndProperties(page: Page) {
  const { x: cx, y: cy } = await canvasCenter(page);

  await clickByLabel(page, 'Add rectangle');
  await page.mouse.move(cx - 180, cy - 60);
  await page.mouse.down();
  await page.mouse.move(cx - 40, cy + 60, { steps: 14 });
  await page.mouse.up();
  await sleep(300);

  await clickByLabel(page, 'Add ellipse');
  await page.mouse.move(cx + 40, cy - 60);
  await page.mouse.down();
  await page.mouse.move(cx + 180, cy + 60, { steps: 14 });
  await page.mouse.up();
  await sleep(300);

  await clickByLabel(page, 'Select tool');
  await sleep(200);
  await page.mouse.click(cx + 110, cy);
  await sleep(600);

  await clickByText(page, 'Design').catch(() => {});
  await sleep(800);

  // Try to interact with the fill color input — change its value via DOM
  const fillInput = page.locator('input[type="color"]').first();
  if ((await fillInput.count()) > 0) {
    await fillInput.evaluate((el: HTMLInputElement) => {
      el.value = '#6366f1';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }).catch(() => {});
    await sleep(600);
  }

  await page.mouse.click(cx - 110, cy);
  await sleep(800);

  await clickByText(page, 'Layers').catch(() => {});
  await sleep(700);
}

async function sceneThemeToggle(page: Page) {
  const { x: cx, y: cy } = await canvasCenter(page);
  await clickByLabel(page, 'Add rectangle');
  await page.mouse.move(cx - 150, cy - 60);
  await page.mouse.down();
  await page.mouse.move(cx - 20, cy + 60, { steps: 12 });
  await page.mouse.up();
  await sleep(300);
  await clickByLabel(page, 'Add ellipse');
  await page.mouse.move(cx + 20, cy - 60);
  await page.mouse.down();
  await page.mouse.move(cx + 150, cy + 60, { steps: 12 });
  await page.mouse.up();
  await sleep(300);
  await clickByLabel(page, 'Select tool');
  await sleep(400);

  await clickByLabel(page, 'Toggle color theme');
  await sleep(1500);
  await clickByLabel(page, 'Toggle color theme');
  await sleep(1100);
}

async function sceneZoomPan(page: Page) {
  const { x: cx, y: cy } = await canvasCenter(page);
  await clickByLabel(page, 'Add rectangle');
  await page.mouse.move(cx - 120, cy - 60);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 60, { steps: 14 });
  await page.mouse.up();
  await sleep(300);
  await clickByLabel(page, 'Add text');
  await page.mouse.click(cx, cy - 130);
  await page.keyboard.type('Infinite Canvas', { delay: 50 });
  await sleep(300);
  await page.mouse.click(cx, cy + 200);
  await sleep(300);
  await clickByLabel(page, 'Select tool');
  await sleep(300);

  for (let i = 0; i < 3; i++) {
    await clickByLabel(page, 'Zoom in');
    await sleep(350);
  }
  await page.keyboard.down('Space');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 250, cy - 150, { steps: 20 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await sleep(400);

  for (let i = 0; i < 3; i++) {
    await clickByLabel(page, 'Zoom out');
    await sleep(300);
  }
  await sleep(500);
}

async function sceneCommandPalette(page: Page) {
  await page.keyboard.press('Control+Meta+K');
  await sleep(1000);

  await page.keyboard.type('rectangle', { delay: 70 });
  await sleep(900);

  await page.keyboard.press('Escape');
  await sleep(400);
  await page.keyboard.press('Control+Meta+K');
  await sleep(700);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('ArrowDown');
    await sleep(220);
  }
  await page.keyboard.press('Escape');
  await sleep(400);
}

// Agent chat — bounded to 12s. We type the prompt, submit, and let the UI
// stream whatever the LLM produces within that window. If the endpoint is
// slow, the z.ai sandbox fallback kicks in; either way we capture the
// "thoughts + tool-call card streaming in" UX. We never wait more than 12s.
async function sceneAgentChat(page: Page) {
  const ta = page.locator('textarea').first();
  await ta.click();
  await sleep(200);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await sleep(200);

  // Type the prompt character-by-character so the recording shows the typing.
  await ta.pressSequentially('Draw a single blue rectangle in the center', { delay: 55 });
  await sleep(500);

  await page.keyboard.press('Enter');

  // Watch for up to 12s. If a shape lands on canvas, we exit early.
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    await sleep(900);
    const shapeCount = await page.locator('[data-ac-shape-id], [data-shape-id]').count().catch(() => 0);
    if (shapeCount > 0) {
      await sleep(2200);
      break;
    }
  }
}

async function sceneSessionSidebar(page: Page) {
  const leftToggle = page.locator('button[aria-label="Toggle left panel"]').first();
  if ((await leftToggle.count()) > 0) {
    await leftToggle.click().catch(() => {});
    await sleep(500);
  }
  const newChat = page.locator('button[aria-label="New chat"]').first();
  if ((await newChat.count()) > 0) {
    await newChat.click().catch(() => {});
    await sleep(900);
  }
  const ta = page.locator('textarea').first();
  await ta.click().catch(() => {});
  await sleep(500);
}

// --- Main --------------------------------------------------------------------
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('launching browser...');
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });

  const scenes: Array<[string, (p: Page) => Promise<void>]> = [
    ['01-shape-drawing', sceneShapeDrawing],
    ['02-layers-properties', sceneLayersAndProperties],
    ['03-dark-mode', sceneThemeToggle],
    ['04-zoom-pan', sceneZoomPan],
    ['05-command-palette', sceneCommandPalette],
    ['06-agent-chat', sceneAgentChat],
    ['07-session-sidebar', sceneSessionSidebar],
  ];

  const produced: string[] = [];
  for (const [name, drive] of scenes) {
    try {
      const p = await recordScene(browser, name, drive);
      produced.push(p);
    } catch (e) {
      console.error(`✗ scene ${name} failed hard:`, (e as Error).message);
    }
  }

  await browser.close();
  console.log('\n=== produced WebM files ===');
  produced.forEach(p => console.log(' -', p));
  console.log('\nNext step: bash scripts/video-demos/convert-demos.sh');
}

main().catch(e => {
  console.error('record-demos.ts failed:', e);
  process.exit(1);
});
