// Live acceptance probe for the landing-page video wiring + client-resolved
// GitHub stats (2026-09-19 landing uplift). One Chromium pass against the dev
// server: video elements, playback state, poster assets, the SocialProof
// GitHub tile (proves the streamed stats promise actually resolves), and any
// console/page errors. Viewport matches the screenshot harness (1600x1000).
//
// Run: bunx tsx scripts/probe-landing-videos.ts [--base-url=http://127.0.0.1:3000]

import { chromium } from 'playwright-core';

const BASE =
  process.argv.find((a) => a.startsWith('--base-url='))?.slice('--base-url='.length) ??
  'http://127.0.0.1:3000';

async function main() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();

  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300));
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${String(error).slice(0, 300)}`));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="hero-proof-row"]');
  // Give the streamed stats promise time to resolve into the tiles.
  await page.waitForTimeout(2500);

  const videos = await page.$$eval('video', (nodes) =>
    nodes.map((node) => ({
      src: node.getAttribute('src'),
      poster: node.getAttribute('poster'),
      paused: node.paused,
      muted: node.muted,
      loop: node.loop,
      readyState: node.readyState,
      width: node.videoWidth,
      height: node.videoHeight,
    })),
  );

  const heroTime = () => page.evaluate(() => document.querySelector('video')?.currentTime ?? null);
  const heroFrame = await heroTime();
  await page.waitForTimeout(1500);
  const heroFrameLater = await heroTime();

  // Scroll to the gallery motion row so both feature clips enter the viewport.
  await page.locator('[data-testid="gallery-motion-row"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(2500);
  const galleryPlaying = await page.$$eval('[data-testid^="gallery-video-"]', (nodes) =>
    nodes.map((node) => ({ testid: node.getAttribute('data-testid'), paused: (node as HTMLVideoElement).paused })),
  );

  const socialProof = await page.textContent('[data-testid="section-social-proof"]');
  const githubLinks = await page.$$eval('a[href*="github.com"]', (links) => links.map((l) => l.getAttribute('href')));

  console.log(
    JSON.stringify(
      {
        videos,
        heroAdvancing: heroFrame !== null && heroFrameLater !== null && heroFrameLater > heroFrame,
        galleryPlaying,
        socialProofText: socialProof?.replace(/\s+/g, ' ').trim().slice(0, 300),
        githubLinks,
        consoleErrors,
      },
      null,
      2,
    ),
  );

  await context.close();
  await browser.close();
}

main().catch((e) => {
  console.error('Probe failed:', e);
  process.exit(1);
});
