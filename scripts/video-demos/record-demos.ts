// record-demos.ts — high-quality programmatic video recorder for AgentCanvas.
//
//
// REWRITE NOTE
// The original version used Playwright's built-in `recordVideo` context option,
// which is hardcoded by Playwright to VP8 at a 1 Mbps realtime bitrate. That
// produces visible mosquito noise around glyph edges and banding in flat
// gradients — exactly the kind of artifacts that make UI demo clips look bad.
// See https://github.com/microsoft/playwright/issues/31424 — Playwright
// maintainers have declined to expose tuning options because ffmpeg is an
// internal implementation detail.
//
// This rewrite uses Playwright 1.59+'s public `page.screencast` API
// (https://playwright.dev/docs/api/class-screencast), whose `start({ onFrame })`
// option streams raw JPEG frames into a Node-side callback. We pipe those
// frames into a separately-spawned ffmpeg process pinned to `libx264
// -preset ultrafast -crf 18` — the same first-pass pattern used by
// `playwright-recorder-plus` (https://github.com/MuTsunTsai/playwright-recorder-plus).
// The ultrafast preset is mandatory for capture because the encoder must NOT
// fall behind realtime; if it does, stdin backpressure stalls onFrame
// ingestion and the resulting video is shorter than the actual session.
//
// Quality levers applied:
//   - viewport 1920x1200, deviceScaleFactor 2 → effectively 3840x2400 capture
//     of crisp text and shapes.
//   - screencast FPS 25, JPEG quality 100 (lossless-ish source).
//   - capture encoder: libx264 ultrafast crf 18 pix_fmt yuv420p (visually
//     lossless, can't fall behind realtime).
//   - smoother mouse motion: mouse.move steps=30+ instead of 18.
//   - tail padding on every scene so the final state holds for a beat.
//
// The downstream convert-demos.sh transcodes the resulting MP4 into a small
// distribution MP4 (CRF 20, medium preset) plus a palette-optimized GIF
// (palettegen stats_mode=full + paletteuse sierra2_4a dither, lanczos scaler).
//
// Run: bun run scripts/video-demos/record-demos.ts
//
// Prereqs:
//   - dev server on http://127.0.0.1:3000
//   - chromium at /home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome
//   - ffmpeg on PATH

import { chromium, type Browser, type Page } from 'playwright-core';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const APP_URL = 'http://127.0.0.1:3000/';
const CHROME = '/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome';
const OUT_DIR = '/home/z/my-project/download/video-demos';

// Larger viewport + DPR 2 for crisp text in the final downscaled GIF/MP4.
// (3840x2400 capture, downsampled to ~900px wide GIF via lanczos — yields
// sharper glyph edges than capturing at 900 and scaling up.)
const VIEWPORT = { width: 1920, height: 1200 };
const DEVICE_SCALE_FACTOR = 2;

const CAPTURE_FPS = 25;
const SCENE_BUDGET_MS = 20_000;

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

// Spawn an ffmpeg process that reads raw MJPEG frames from stdin and writes
// H.264 ultrafast CRF 18 to the output path. This is the "capture pass" — it
// must NEVER fall behind realtime, so we use the fastest possible preset.
function startCaptureFfmpeg(outPath: string): ChildProcessWithoutNullStreams {
  const args = [
    '-loglevel', 'error',
    '-f', 'image2pipe',
    '-c:v', 'mjpeg',
    '-r', String(CAPTURE_FPS),
    '-i', 'pipe:0',
    '-an',
    '-fps_mode', 'passthrough',   // one output frame per input frame, no dup/drop
    '-c:v', 'libx264',
    '-preset', 'ultrafast',       // mandatory: cannot fall behind realtime
    '-crf', '18',                 // visually lossless
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-y',
    outPath,
  ];
  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'inherit'] });
  proc.on('error', (e) => console.error('ffmpeg spawn error:', e.message));
  return proc;
}

// Inject a 1-pixel heartbeat element with a CSS animation that toggles its
// opacity between 0.01 and 0.99 every 40ms. This forces Chromium's compositor
// to run on every frame, which forces `page.screencast` to emit a frame —
// without it, screencast is diff-based and only fires on visible page changes,
// leaving static scenes (like the session sidebar with no shape mutations) at
// just 1-2 frames for the whole recording. With the heartbeat, we get a steady
// ~25fps stream regardless of how visually active the scene is.
//
// Why CSS animation and not setInterval + opacity toggle? A few subtler
// opacity deltas (0.01↔0.02) are below the compositor's "this frame changed"
// threshold and don't trigger a new composite. A CSS animation swinging all
// the way to 0.99 reliably forces a composite every animation step, runs on
// the compositor thread (no JS overhead), and survives SPA re-renders.
async function startFrameHeartbeat(page: Page): Promise<() => Promise<void>> {
  const inject = `
    (function() {
      if (document.getElementById('__ac_tick')) return;
      const style = document.createElement('style');
      style.textContent = '@keyframes __ac_pulse { 0%,100% { opacity: 0.01 } 50% { opacity: 0.99 } }';
      document.head.appendChild(style);
      const tick = document.createElement('div');
      tick.id = '__ac_tick';
      tick.style.cssText = 'position:fixed;top:0;left:0;width:2px;height:2px;pointer-events:none;z-index:999999;background:#000;animation:__ac_pulse 0.04s infinite;';
      document.documentElement.appendChild(tick);
    })();
  `;
  await page.addInitScript(inject).catch(() => {});
  await page.evaluate(inject).catch(() => {});
  return async () => {
    await page.evaluate(() => {
      const el = document.getElementById('__ac_tick');
      if (el) el.remove();
    }).catch(() => {});
  };
}

// Record a single scene. Spawns its own ffmpeg capture process; pipes
// screencast JPEG frames into it; on stop, flushes stdin so ffmpeg finalizes.
async function recordScene(
  browser: Browser,
  name: string,
  drive: (page: Page) => Promise<void>
): Promise<string> {
  console.log(`\n▶ scene: ${name}`);
  const outPath = path.join(OUT_DIR, `${name}.mp4`);
  const ffmpeg = startCaptureFfmpeg(outPath);
  const stdin = ffmpeg.stdin;
  stdin.on('error', () => {}); // guard against EPIPE on early-finalize races

  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
  });
  const page = await ctx.newPage();

  let frameCount = 0;
  const screencast = page.screencast;

  try {
    await waitReady(page);
    const stopHeartbeat = await startFrameHeartbeat(page);
    await screencast.start({
      onFrame: (frame: { data: Buffer }) => {
        if (!stdin.destroyed && stdin.writable) {
          stdin.write(frame.data, (err) => {
            if (err) console.warn(`  ⚠ frame write err: ${err.message}`);
          });
          frameCount++;
        }
      },
      quality: 100,
      size: VIEWPORT, // capture at full CSS viewport (DPR 2 means glyph-quality is retina)
    }).catch((e: Error) => {
      console.warn('  ⚠ screencast.start failed:', e.message);
    });
    await Promise.race([
      drive(page),
      sleep(SCENE_BUDGET_MS).then(() => {
        console.warn(`  ⚠ scene "${name}" hit ${SCENE_BUDGET_MS}ms budget`);
      }),
    ]);
    await sleep(900); // tail — let final state hold
    await screencast.stop().catch(() => {});
    await stopHeartbeat();
    console.log(`  (${frameCount} frames captured)`);
  } catch (e) {
    console.warn(`  ⚠ scene "${name}" error:`, (e as Error).message);
    await screencast.stop().catch(() => {});
  } finally {
    // Drain pending frames, then close stdin so ffmpeg flushes its encoder.
    await sleep(200);
    stdin.end();
    await new Promise<void>((resolve) => {
      ffmpeg.once('exit', () => resolve());
      setTimeout(() => { try { ffmpeg.kill('SIGKILL'); } catch {} resolve(); }, 15_000);
    });
    await ctx.close().catch(() => {});
    if (fs.existsSync(outPath)) {
      const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
      console.log(`  ✓ ${outPath} (${kb} KB, ${frameCount} frames)`);
      return outPath;
    } else {
      console.error(`  ✗ ${outPath} not produced`);
      return '';
    }
  }
}

// --- Scenes (same flow as before, smoother mouse motion) ---------------------

async function sceneShapeDrawing(page: Page) {
  const { x: cx, y: cy } = await canvasCenter(page);

  await clickByLabel(page, 'Add rectangle');
  await sleep(400);
  await page.mouse.move(cx - 280, cy - 100);
  await page.mouse.down();
  await page.mouse.move(cx - 60, cy + 80, { steps: 30 });
  await page.mouse.up();
  await sleep(600);

  await clickByLabel(page, 'Select tool');
  await sleep(150);
  await clickByLabel(page, 'Add ellipse');
  await sleep(400);
  await page.mouse.move(cx + 80, cy - 100);
  await page.mouse.down();
  await page.mouse.move(cx + 300, cy + 80, { steps: 30 });
  await page.mouse.up();
  await sleep(600);

  await clickByLabel(page, 'Add text');
  await sleep(400);
  await page.mouse.click(cx - 40, cy + 160);
  await sleep(300);
  await page.keyboard.type('AgentCanvas', { delay: 80 });
  await sleep(400);
  await page.mouse.click(cx, cy - 280);
  await sleep(600);
}

async function sceneLayersAndProperties(page: Page) {
  const { x: cx, y: cy } = await canvasCenter(page);

  await clickByLabel(page, 'Add rectangle');
  await page.mouse.move(cx - 220, cy - 80);
  await page.mouse.down();
  await page.mouse.move(cx - 40, cy + 80, { steps: 24 });
  await page.mouse.up();
  await sleep(400);

  await clickByLabel(page, 'Add ellipse');
  await page.mouse.move(cx + 40, cy - 80);
  await page.mouse.down();
  await page.mouse.move(cx + 220, cy + 80, { steps: 24 });
  await page.mouse.up();
  await sleep(400);

  await clickByLabel(page, 'Select tool');
  await sleep(200);
  await page.mouse.click(cx + 130, cy);
  await sleep(700);

  await clickByText(page, 'Design').catch(() => {});
  await sleep(900);

  const fillInput = page.locator('input[type="color"]').first();
  if ((await fillInput.count()) > 0) {
    await fillInput.evaluate((el: HTMLInputElement) => {
      el.value = '#6366f1';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }).catch(() => {});
    await sleep(700);
  }

  await page.mouse.click(cx - 130, cy);
  await sleep(900);

  await clickByText(page, 'Layers').catch(() => {});
  await sleep(800);
}

async function sceneThemeToggle(page: Page) {
  const { x: cx, y: cy } = await canvasCenter(page);
  await clickByLabel(page, 'Add rectangle');
  await page.mouse.move(cx - 180, cy - 80);
  await page.mouse.down();
  await page.mouse.move(cx - 20, cy + 80, { steps: 20 });
  await page.mouse.up();
  await sleep(400);
  await clickByLabel(page, 'Add ellipse');
  await page.mouse.move(cx + 20, cy - 80);
  await page.mouse.down();
  await page.mouse.move(cx + 180, cy + 80, { steps: 20 });
  await page.mouse.up();
  await sleep(400);
  await clickByLabel(page, 'Select tool');
  await sleep(400);

  await clickByLabel(page, 'Toggle color theme');
  await sleep(1700);
  await clickByLabel(page, 'Toggle color theme');
  await sleep(1200);
}

async function sceneZoomPan(page: Page) {
  const { x: cx, y: cy } = await canvasCenter(page);
  await clickByLabel(page, 'Add rectangle');
  await page.mouse.move(cx - 140, cy - 80);
  await page.mouse.down();
  await page.mouse.move(cx + 140, cy + 80, { steps: 24 });
  await page.mouse.up();
  await sleep(400);
  await clickByLabel(page, 'Add text');
  await page.mouse.click(cx, cy - 160);
  await page.keyboard.type('Infinite Canvas', { delay: 60 });
  await sleep(400);
  await page.mouse.click(cx, cy + 240);
  await sleep(400);
  await clickByLabel(page, 'Select tool');
  await sleep(400);

  for (let i = 0; i < 4; i++) {
    await clickByLabel(page, 'Zoom in');
    await sleep(380);
  }
  await page.keyboard.down('Space');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 300, cy - 180, { steps: 30 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await sleep(500);

  for (let i = 0; i < 4; i++) {
    await clickByLabel(page, 'Zoom out');
    await sleep(330);
  }
  await sleep(600);
}

async function sceneCommandPalette(page: Page) {
  await page.keyboard.press('Control+Meta+K');
  await sleep(1100);

  await page.keyboard.type('rectangle', { delay: 80 });
  await sleep(1000);

  await page.keyboard.press('Escape');
  await sleep(500);
  await page.keyboard.press('Control+Meta+K');
  await sleep(800);
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('ArrowDown');
    await sleep(240);
  }
  await page.keyboard.press('Escape');
  await sleep(500);
}

async function sceneAgentChat(page: Page) {
  const ta = page.locator('textarea').first();
  await ta.click();
  await sleep(200);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await sleep(200);

  await ta.pressSequentially('Draw a single blue rectangle in the center', { delay: 55 });
  await sleep(500);

  await page.keyboard.press('Enter');

  const deadline = Date.now() + 14_000;
  while (Date.now() < deadline) {
    await sleep(900);
    const shapeCount = await page.locator('[data-ac-shape-id], [data-shape-id]').count().catch(() => 0);
    if (shapeCount > 0) {
      await sleep(2500);
      break;
    }
  }
}

async function sceneSessionSidebar(page: Page) {
  const leftToggle = page.locator('button[aria-label="Toggle left panel"]').first();
  if ((await leftToggle.count()) > 0) {
    await leftToggle.click().catch(() => {});
    await sleep(600);
  }
  const newChat = page.locator('button[aria-label="New chat"]').first();
  if ((await newChat.count()) > 0) {
    await newChat.click().catch(() => {});
    await sleep(1000);
  }
  const ta = page.locator('textarea').first();
  await ta.click().catch(() => {});
  await sleep(600);
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
      if (p) produced.push(p);
    } catch (e) {
      console.error(`✗ scene ${name} failed hard:`, (e as Error).message);
    }
  }

  await browser.close();
  console.log('\n=== produced MP4 capture files ===');
  produced.forEach(p => console.log(' -', p));
  console.log('\nNext step: bash scripts/video-demos/convert-demos.sh');
}

main().catch(e => {
  console.error('record-demos.ts failed:', e);
  process.exit(1);
});
