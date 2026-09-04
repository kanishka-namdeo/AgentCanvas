// record-agent-only.ts — re-record ONLY the agent-chat scene.
//
// Used to fix the issue where the prior core-agent-chat.mp4 showed the agent
// thinking but no shapes ever appeared on the canvas (the prompt was too
// complex and triggered gen_generate_variants planning instead of direct
// pen_create_shape calls). This script runs sceneAgentChat in isolation
// with the corrected prompt + extended budget.
//
// Run: bun run scripts/video-demos/record-agent-only.ts

import { chromium } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';

// Inline the scene + helpers from record-core-videos.ts to avoid module
// resolution friction. (Same code, just standalone.)

const CHROME = '/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome';
const OUT_DIR = '/home/z/my-project/download/video-demos';
const VIEWPORT = { width: 1920, height: 1200 };
const DEVICE_SCALE_FACTOR = 2;
const CAPTURE_FPS = 25;
// IMPORTANT: load via the Caddy gateway on :81, NOT directly on :3000.
// The app's Socket.IO client connects to '/?XTransformPort=3003' — a RELATIVE
// URL. When the page is loaded on :3000 directly, that relative URL resolves
// to ws://127.0.0.1:3000/socket.io?XTransformPort=3003, and the Next.js dev
// server on :3000 does NOT understand the XTransformPort query param — so
// the Socket.IO handshake fails and the canvas never receives the agent's
// patches (the agent runs fine server-side, but the shapes never appear on
// the canvas). Loading via :81 routes the Socket.IO connection through the
// Caddy gateway, which DOES interpret XTransformPort and proxies to :3003.
const APP_URL = 'http://127.0.0.1:81/';
const SCENE_BUDGET_MS = 80_000; // dashboard generation takes ~30-40s (brief + LLM + 128 shapes)

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type { Browser, Page } from 'playwright-core';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function waitReady(page: Page) {
  // Clear localStorage before navigating so the canvas starts EMPTY (not
  // persisted with leftover shapes from prior runs). The Zustand canvas
  // store persists to localStorage, so without this the demo would show
  // stale shapes from previous agent calls.
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.evaluate(() => {
    try { localStorage.clear(); } catch {}
  });
  await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await sleep(2500);
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

async function sceneAgentChat(page: Page) {
  // Use a fresh documentId for each recording so the canvas starts completely
  // empty (no leftover shapes from prior agent runs persisted in localStorage
  // or the server journal). The app creates the document on first reference.
  const docId = `video-demo-${Date.now()}`;
  await page.goto(`${APP_URL}?doc=${docId}`, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
  await sleep(2000);
  // Also clear localStorage as a belt-and-suspenders measure.
  await page.evaluate(() => { try { localStorage.clear(); } catch {} }).catch(() => {});
  await page.reload({ waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
  await sleep(2000);

  const ta = page.locator('textarea').first();
  await ta.click();
  await sleep(300);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await sleep(200);

  // Prompt verified via live API testing to reliably produce a full dashboard
  // wireframe (128 shapes, VLM-rated 8/10 — "clean, modern dashboard wireframe
  // for Acme featuring sidebar navigation, stat cards, and a revenue chart").
  // This showcases the agent's actual UI generation capability — the headline
  // use case of "Figma alternative for agentic UI/UX generation."
  await ta.pressSequentially('Generate a dashboard wireframe with a sidebar, a header, 4 stat cards, and a chart area', { delay: 35 });
  await sleep(700);

  // Capture the baseline node count BEFORE submitting — the canvas always
  // has a few frame/layer wrapper nodes even when "empty" of user shapes.
  const initialShapeCount = await page.locator('[data-node-id]').count().catch(() => 0);
  console.log(`  baseline node count: ${initialShapeCount}`);

  await page.keyboard.press('Enter');

  const deadline = Date.now() + 70_000;
  let lastToolCardCount = 0;
  let stableSince = 0;
  let lastShapeCount = 0;
  while (Date.now() < deadline) {
    await sleep(1500);
    const shapeCount = await page.locator('[data-node-id]').count().catch(() => 0);
    const toolCardCount = await page.locator('[class*="tool-call"], [class*="ToolCall"], [data-tool-call-id]').count().catch(() => 0);
    console.log(`  t+${((Date.now() - (deadline - 50000)) / 1000).toFixed(1)}s: shapes=${shapeCount}, toolCards=${toolCardCount}`);
    // The canvas starts with ~2 frame/layer wrapper nodes, so we look for
    // shapeCount increasing by 3 (the 3 shapes the prompt asks for).
    if (shapeCount >= initialShapeCount + 10) {
      if (toolCardCount === lastToolCardCount) {
        stableSince += 1500;
        if (stableSince >= 3000) {
          await sleep(2000);
          break;
        }
      } else {
        stableSince = 0;
        lastToolCardCount = toolCardCount;
      }
    }
    lastShapeCount = shapeCount;
  }
  console.log(`  final: ${lastShapeCount} shapes on canvas`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'core-agent-chat.mp4');
  console.log('▶ recording core-agent-chat (corrected prompt)');

  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const ffmpeg = startCaptureFfmpeg(outPath);
  const stdin = ffmpeg.stdin;
  stdin.on('error', () => {});

  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR });
  const page = await ctx.newPage();
  let frameCount = 0;

  try {
    await waitReady(page);
    const stopHeartbeat = await startFrameHeartbeat(page);
    await page.screencast.start({
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
      sceneAgentChat(page),
      sleep(SCENE_BUDGET_MS).then(() => console.warn(`  ⚠ hit ${SCENE_BUDGET_MS}ms budget`)),
    ]);
    await sleep(1500);
    await page.screencast.stop().catch(() => {});
    await stopHeartbeat();
    console.log(`(${frameCount} frames captured)`);
  } catch (e) {
    console.warn(`  ⚠ error:`, (e as Error).message);
    await page.screencast.stop().catch(() => {});
  } finally {
    await sleep(200);
    stdin.end();
    await new Promise<void>((resolve) => {
      ffmpeg.once('exit', () => resolve());
      setTimeout(() => { try { ffmpeg.kill('SIGKILL'); } catch {} resolve(); }, 15_000);
    });
    await ctx.close().catch(() => {});
    await browser.close();
    if (fs.existsSync(outPath)) {
      console.log(`✓ ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
    } else {
      console.error(`✗ ${outPath} not produced`);
    }
  }
}

main().catch(e => { console.error('record-agent-only.ts failed:', e); process.exit(1); });
