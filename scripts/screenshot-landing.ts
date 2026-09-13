// Landing-page visual verification (2026-09-13) — modeled on
// scripts/screenshot-ui-after.ts (same Playwright setup + output
// convention per scripts/AGENTS.md, viewport default 1440x900).
//
// Captures, into download/landing-verify/:
//   01-desktop-full.png      desktop 1440x900 full page
//   02..06-desktop-<id>.png  per-section viewport shots (id-anchored)
//   07-mobile-full.png       mobile 390x844 full page
//   08-reduced-motion.png    hero under prefers-reduced-motion: reduce
//
// Run: bunx tsx scripts/screenshot-landing.ts   (dev server on :3000)

import { chromium } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';

// Output relative to the repo root (scripts/AGENTS.md rule) — NOT the
// hardcoded sandbox path the older screenshot script uses.
const OUT_DIR = path.resolve(process.cwd(), 'download/landing-verify');
const BASE_URL = 'http://127.0.0.1:3000/';

const SECTION_IDS = ['top', 'magic', 'tool', 'trust', 'how-it-works', 'open-source'];

// playwright-core ships without browsers; try the default registry first,
// then system Chrome, then system Edge (Windows dev machines always have
// Edge; the sandbox has the default registry browsers).
async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    try {
      return await chromium.launch({ headless: true, channel: 'chrome' });
    } catch {
      return await chromium.launch({ headless: true, channel: 'msedge' });
    }
  }
}

function twoDigit(index: number): string {
  return index < 10 ? `0${index}` : `${index}`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await launchBrowser();

  // ── Desktop pass ──────────────────────────────────────────────────────
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await desktop.newPage();
  console.log('→ navigating to', BASE_URL);
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  // Let React hydrate + the dynamic sections land.
  await page.waitForTimeout(3000);

  await page.screenshot({ path: path.join(OUT_DIR, '01-desktop-full.png'), fullPage: true });
  console.log('✓ 01-desktop-full.png');

  let shotIndex = 2;
  for (const id of SECTION_IDS) {
    const section = page.locator(`#${id}`);
    await section.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(600); // let whileInView reveals settle
    await page.screenshot({ path: path.join(OUT_DIR, `${twoDigit(shotIndex)}-desktop-${id}.png`) });
    console.log(`✓ ${twoDigit(shotIndex)}-desktop-${id}.png`);
    shotIndex += 1;
  }
  await desktop.close();

  // ── Mobile pass (spec §10: simplified animations, same content order) ─
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await mobilePage.waitForTimeout(3000);
  await mobilePage.screenshot({ path: path.join(OUT_DIR, `${twoDigit(shotIndex)}-mobile-full.png`), fullPage: true });
  console.log(`✓ ${twoDigit(shotIndex)}-mobile-full.png`);
  shotIndex += 1;
  await mobile.close();

  // ── Reduced-motion pass (spec §10 static fallbacks) ───────────────────
  const reduced = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });
  const reducedPage = await reduced.newPage();
  await reducedPage.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await reducedPage.waitForTimeout(1500);
  await reducedPage.screenshot({ path: path.join(OUT_DIR, `${twoDigit(shotIndex)}-reduced-motion.png`) });
  console.log(`✓ ${twoDigit(shotIndex)}-reduced-motion.png`);
  await reduced.close();

  await browser.close();
  console.log('\nAll screenshots saved to', OUT_DIR);
}

main().catch((e) => {
  console.error('Screenshot script failed:', e);
  process.exit(1);
});
