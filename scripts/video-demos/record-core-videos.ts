// record-core-videos.ts — record the 2 CORE workflow videos only.
//
// Context: the prior record-demos.ts produced 7 small clips, which cluttered
// the README. After a codebase scan, the 2 workflows that define AgentCanvas
// are:
//
//   1. Agent chat → live canvas mutation (the literal product)
//   2. Human-in-the-loop trust: diff card + approval gate (the differentiator)
//
// This script records JUST those two, with richer prompts than before:
//   - Video 1 prompts the agent to design a mobile login screen (multi-tool,
//     produces visible shapes, ends with the turn-diff chip).
//   - Video 2 draws a couple of shapes manually, then asks the agent to
//     "clear the canvas" — which triggers the approval gate (pen_clear is
//     in DESTRUCTIVE_TOOLS). We capture the dialog appearing, then click
//     Deny to show the canvas is preserved.
//
// Same high-quality pipeline as record-demos.ts: page.screencast.onFrame →
// ffmpeg libx264 ultrafast crf 18 capture at 1920x1200 DPR 2, with a CSS
// heartbeat to force steady 25fps.
//
// Run: bun run scripts/video-demos/record-core-videos.ts

import { chromium, type Browser, type Page } from 'playwright-core';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const APP_URL = 'http://127.0.0.1:81/';
// IMPORTANT: load via the Caddy gateway on :81, NOT directly on :3000.
// The app's Socket.IO client connects to '/?XTransformPort=3003' — a RELATIVE
// URL. When the page is loaded on :3000 directly, that resolves to
// ws://127.0.0.1:3000/socket.io?XTransformPort=3003, and the Next.js dev
// server does NOT understand the XTransformPort query param — so the
// Socket.IO handshake fails and the canvas never receives the agent's
// patches (the agent runs fine server-side, but shapes never appear on the
// canvas). Loading via :81 routes the Socket.IO connection through the
// Caddy gateway, which DOES interpret XTransformPort and proxies to :3003.
const CHROME = '/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome';
const OUT_DIR = '/home/z/my-project/download/video-demos';

const VIEWPORT = { width: 1920, height: 1200 };
const DEVICE_SCALE_FACTOR = 2;
const CAPTURE_FPS = 25;
const SCENE_BUDGET_MS = 55_000; // longer for the agent-chat scene (LLM call + 3 tool calls)

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function waitReady(page: Page) {
  await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await sleep(2500);
}

async function clickByLabel(page: Page, label: string) {
  await page.locator(`button[aria-label="${label}"]`).first().click({ timeout: 5000 });
}

async function canvasCenter(page: Page) {
  for (const sel of ['[data-ac-canvas]', '[class*="ac-canvas"]', '[class*="canvas-root"]', 'main [role="presentation"]', 'main']) {
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

function startCaptureFfmpeg(outPath: string): ChildProcessWithoutNullStreams {
  const args = [
    '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg',
    '-r', String(CAPTURE_FPS), '-i', 'pipe:0', '-an',
    '-fps_mode', 'passthrough',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', outPath,
  ];
  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'inherit'] });
  proc.on('error', (e) => console.error('ffmpeg spawn error:', e.message));
  return proc;
}

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
    await page.evaluate(() => { const el = document.getElementById('__ac_tick'); if (el) el.remove(); }).catch(() => {});
  };
}

async function recordScene(
  browser: Browser,
  name: string,
  drive: (page: Page) => Promise<void>
): Promise<string> {
  console.log(`\n▶ scene: ${name}`);
  const outPath = path.join(OUT_DIR, `${name}.mp4`);
  const ffmpeg = startCaptureFfmpeg(outPath);
  const stdin = ffmpeg.stdin;
  stdin.on('error', () => {});

  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR });
  const page = await ctx.newPage();
  let frameCount = 0;
  const screencast = page.screencast;

  try {
    await waitReady(page);
    const stopHeartbeat = await startFrameHeartbeat(page);
    await screencast.start({
      onFrame: (frame: { data: Buffer }) => {
        if (!stdin.destroyed && stdin.writable) {
          stdin.write(frame.data, (err) => { if (err) console.warn(`  ⚠ frame write err: ${err.message}`); });
          frameCount++;
        }
      },
      quality: 100,
      size: VIEWPORT,
    }).catch((e: Error) => console.warn('  ⚠ screencast.start failed:', e.message));

    await Promise.race([
      drive(page),
      sleep(SCENE_BUDGET_MS).then(() => console.warn(`  ⚠ scene "${name}" hit ${SCENE_BUDGET_MS}ms budget`)),
    ]);
    await sleep(1200);
    await screencast.stop().catch(() => {});
    await stopHeartbeat();
    console.log(`  (${frameCount} frames captured)`);
  } catch (e) {
    console.warn(`  ⚠ scene "${name}" error:`, (e as Error).message);
    await screencast.stop().catch(() => {});
  } finally {
    await sleep(200);
    stdin.end();
    await new Promise<void>((resolve) => {
      ffmpeg.once('exit', () => resolve());
      setTimeout(() => { try { ffmpeg.kill('SIGKILL'); } catch {} resolve(); }, 15_000);
    });
    await ctx.close().catch(() => {});
    if (fs.existsSync(outPath)) {
      console.log(`  ✓ ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
      return outPath;
    }
    console.error(`  ✗ ${outPath} not produced`);
    return '';
  }
}

// --- Scene 1: Agent chat → live canvas mutation (the headline) --------------
//
// We use a prompt that RELIABLY produces visible, distinct, colored shapes on
// the canvas (verified via live API testing — the agent calls pen_create_shape
// 3 times for this prompt, producing a red rectangle, green ellipse, and text
// label). Richer prompts like "Design a mobile login screen" tended to
// trigger the gen_generate_variants planning tool instead of direct shape
// creation, leaving the canvas empty — which defeats the purpose of the demo.
async function sceneAgentChat(page: Page) {
  // Use a fresh documentId for each recording so the canvas starts completely
  // empty (no leftover shapes from prior agent runs persisted in localStorage
  // or the server journal). The app reads ?doc=ID from the URL (page.tsx:68).
  const docId = `video-demo-${Date.now()}`;
  await page.goto(`${APP_URL}?doc=${docId}`, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
  await sleep(2000);
  await page.evaluate(() => { try { localStorage.clear(); } catch {} }).catch(() => {});
  await page.reload({ waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
  await sleep(2000);

  const ta = page.locator('textarea').first();
  await ta.click();
  await sleep(300);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await sleep(200);

  // Prompt verified via live API testing to reliably produce 3 distinct,
  // visible, colored shapes (red rectangle, green ellipse, blue text "Hello").
  // Richer prompts like "Design a mobile login screen" trigger the
  // gen_generate_variants planning tool instead of direct pen_create_shape
  // calls, leaving the canvas empty.
  await ta.pressSequentially('Draw a red rectangle, a green circle, and a blue text label saying Hello, arranged in a row', { delay: 35 });
  await sleep(700);

  // Capture baseline BEFORE submitting — the canvas has a few frame/layer
  // wrapper nodes even when empty of user shapes.
  const initialShapeCount = await page.locator('[data-node-id]').count().catch(() => 0);
  console.log(`  baseline node count: ${initialShapeCount}`);

  await page.keyboard.press('Enter');

  // Watch the agent loop. The canvas DOM renders each shape with a
  // data-node-id attribute (NOT data-ac-shape-id — that was a wrong guess
  // in the prior version that caused 0 shapes to be detected). Exit early
  // once 3+ new shapes appear AND the turn has settled.
  const deadline = Date.now() + 50_000;
  let lastToolCardCount = 0;
  let stableSince = 0;
  while (Date.now() < deadline) {
    await sleep(1500);
    const shapeCount = await page.locator('[data-node-id]').count().catch(() => 0);
    const toolCardCount = await page.locator('[class*="tool-call"], [class*="ToolCall"], [data-tool-call-id]').count().catch(() => 0);
    if (shapeCount >= initialShapeCount + 3) {
      if (toolCardCount === lastToolCardCount) {
        stableSince += 1500;
        if (stableSince >= 3000) {
          await sleep(2000); // let the turn-diff chip render
          break;
        }
      } else {
        stableSince = 0;
        lastToolCardCount = toolCardCount;
      }
    }
  }
  await sleep(1500);
}

// --- Scene 2: Human-in-the-loop trust (diff card + approval gate) -----------
//
// 1. Draw 2-3 shapes manually so the canvas has visible content.
// 2. Submit a prompt that asks the agent to "clear the canvas" — this
//    triggers the approval gate because `pen_clear` is in DESTRUCTIVE_TOOLS.
// 3. The Allow/Deny dialog appears. We capture it for ~2s, then click Deny
//    to show the canvas is preserved (the trust payoff).
// 4. If the dialog doesn't appear within 25s (agent slow / no destructive
//    call), we fall back to expanding an existing diff card from a prior
//    turn — still a meaningful trust-UX demo.
async function sceneTrustLoop(page: Page) {
  const { x: cx, y: cy } = await canvasCenter(page);

  // 1) Draw a couple of shapes so there's something to "destroy".
  await clickByLabel(page, 'Add rectangle');
  await sleep(400);
  await page.mouse.move(cx - 200, cy - 80);
  await page.mouse.down();
  await page.mouse.move(cx - 40, cy + 60, { steps: 24 });
  await page.mouse.up();
  await sleep(400);

  await clickByLabel(page, 'Add ellipse');
  await sleep(400);
  await page.mouse.move(cx + 40, cy - 80);
  await page.mouse.down();
  await page.mouse.move(cx + 200, cy + 60, { steps: 24 });
  await page.mouse.up();
  await sleep(400);

  await clickByLabel(page, 'Add text');
  await sleep(400);
  await page.mouse.click(cx, cy + 140);
  await sleep(300);
  await page.keyboard.type('Canvas content', { delay: 60 });
  await sleep(400);
  await page.mouse.click(cx, cy - 220);
  await sleep(400);

  // Switch to select tool so the canvas is in a neutral state.
  await clickByLabel(page, 'Select tool');
  await sleep(400);

  // 2) Prompt the agent to clear the canvas — triggers pen_clear → approval.
  const ta = page.locator('textarea').first();
  await ta.click();
  await sleep(200);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await sleep(200);
  await ta.pressSequentially('Clear all the shapes from the canvas', { delay: 50 });
  await sleep(600);
  await page.keyboard.press('Enter');

  // 3) Wait for the approval dialog to appear (up to 25s for the agent to
  //    classify the intent + dispatch the destructive tool call).
  let dialogAppeared = false;
  const dialogDeadline = Date.now() + 25_000;
  while (Date.now() < dialogDeadline) {
    await sleep(800);
    // The approval dialog is rendered as an AlertDialog with Allow/Deny.
    const denyBtn = page.getByRole('button', { name: /^Deny$/i }).first();
    const allowBtn = page.getByRole('button', { name: /^Allow$/i }).first();
    if ((await denyBtn.count()) > 0 && (await allowBtn.count()) > 0) {
      dialogAppeared = true;
      // Hold the dialog on screen for ~2s so the GIF clearly shows it.
      await sleep(2200);
      // Click Deny — the canvas is preserved, demonstrating the trust payoff.
      await denyBtn.click().catch(() => {});
      await sleep(1800);
      break;
    }
  }

  // 4) Fallback: if the approval dialog never appeared (agent slow / no
  //    destructive call), expand a diff card from the chat history to still
  //    show the trust-UX surface.
  if (!dialogAppeared) {
    console.warn('  ⚠ approval dialog did not appear — falling back to diff-card expand');
    const diffCard = page.locator('[class*="diff-card"], [class*="DiffCard"], button:has-text("Created"), button:has-text("Updated")').first();
    if ((await diffCard.count()) > 0) {
      await diffCard.click().catch(() => {});
      await sleep(1800);
    }
  }
  await sleep(1500);
}

// --- Main --------------------------------------------------------------------

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('launching browser...');
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });

  const scenes: Array<[string, (p: Page) => Promise<void>]> = [
    ['core-agent-chat', sceneAgentChat],
    ['core-trust-loop', sceneTrustLoop],
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
  console.log('\nNext step: bash scripts/video-demos/convert-core-videos.sh');
}

main().catch(e => {
  console.error('record-core-videos.ts failed:', e);
  process.exit(1);
});
