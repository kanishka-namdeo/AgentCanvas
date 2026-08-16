// Screenshot script — captures the three polish deliverables:
//   1. Empty-canvas drop zone (no shapes yet)
//   2. Dark-mode toggle (light + dark side-by-side comparison)
//   3. Polished rename Dialog + dropdown menu
//
// Run via: bunx tsx scripts/screenshot-polish-pass2.ts
// Output: /home/z/my-project/download/polish-pass2/*.png

import { chromium } from 'playwright';
import { mkdir } from 'fs/promises';
import path from 'path';

const OUT_DIR = '/home/z/my-project/download/polish-pass2';
const BASE = 'http://127.0.0.1:3000';

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  // Clear localStorage so we always start fresh (empty canvas + light mode).
  await page.addInitScript(() => {
    localStorage.removeItem('agentcanvas-sessions');
    localStorage.removeItem('agentcanvas-theme');
  });

  // 1) Initial empty canvas with drop zone — light mode.
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT_DIR, '01-empty-canvas-dropzone.png'), fullPage: false });
  console.log('captured 01-empty-canvas-dropzone.png');

  // 2) Hover the "New chat" button to show it's a solid violet CTA.
  await page.hover('button:has-text("New chat")');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT_DIR, '02-new-chat-hover.png'), fullPage: false });
  console.log('captured 02-new-chat-hover.png');

  // Click New chat so we have a session row to hover.
  await page.click('button:has-text("New chat")');
  await page.waitForTimeout(500);

  // 3) Hover a session row to reveal the ⋯ menu trigger.
  const sessionRow = await page.$('div.group:has-text("New chat")');
  if (sessionRow) {
    await sessionRow.hover();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT_DIR, '03-session-row-hover.png'), fullPage: false });
    console.log('captured 03-session-row-hover.png');

    // 4) Click the ⋯ trigger to open the polished dropdown.
    const trigger = await page.$('div.group:has-text("New chat") button:has(svg MoreHorizontal), div.group:has-text("New chat") button >> nth=0');
    // The ⋯ button is the only button inside the row's right-side hover area.
    const moreBtn = await page.$('div.group:has-text("New chat") .opacity-100 button, div.group:has-text("New chat") button >> nth=0');
    if (moreBtn) {
      await moreBtn.click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT_DIR, '04-dropdown-menu-open.png'), fullPage: false });
      console.log('captured 04-dropdown-menu-open.png');
    }
  }

  // 5) Open the rename dialog via keyboard: Escape first, then trigger rename.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Re-open dropdown and click Rename.
  const sessionRow2 = await page.$('div.group:has-text("New chat")');
  if (sessionRow2) {
    await sessionRow2.hover();
    await page.waitForTimeout(200);
    const moreBtn = await page.$('div.group:has-text("New chat") button >> nth=0');
    if (moreBtn) {
      await moreBtn.click();
      await page.waitForTimeout(300);
      // Click the Rename item.
      const renameItem = await page.$('[role="menuitem"]:has-text("Rename")');
      if (renameItem) {
        await renameItem.click();
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(OUT_DIR, '05-rename-dialog.png'), fullPage: false });
        console.log('captured 05-rename-dialog.png');
      }
    }
  }

  // Close dialog.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 6) Toggle dark mode — click the theme toggle in the top bar.
  //    The toggle is the last button in the status pills row.
  const themeToggle = await page.$('button[aria-label="Toggle color theme"]');
  if (themeToggle) {
    await themeToggle.click();
    await page.waitForTimeout(700); // let tokens re-flow
    await page.screenshot({ path: path.join(OUT_DIR, '06-dark-mode-empty.png'), fullPage: false });
    console.log('captured 06-dark-mode-empty.png');
  }

  // 7) Dark mode + dropdown open — verify dropdown tokens swap correctly.
  const sessionRow3 = await page.$('div.group:has-text("New chat")');
  if (sessionRow3) {
    await sessionRow3.hover();
    await page.waitForTimeout(200);
    const moreBtn = await page.$('div.group:has-text("New chat") button >> nth=0');
    if (moreBtn) {
      await moreBtn.click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT_DIR, '07-dark-mode-dropdown.png'), fullPage: false });
      console.log('captured 07-dark-mode-dropdown.png');
    }
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // 8) Dark mode + rename dialog.
  const sessionRow4 = await page.$('div.group:has-text("New chat")');
  if (sessionRow4) {
    await sessionRow4.hover();
    await page.waitForTimeout(200);
    const moreBtn = await page.$('div.group:has-text("New chat") button >> nth=0');
    if (moreBtn) {
      await moreBtn.click();
      await page.waitForTimeout(300);
      const renameItem = await page.$('[role="menuitem"]:has-text("Rename")');
      if (renameItem) {
        await renameItem.click();
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(OUT_DIR, '08-dark-mode-rename-dialog.png'), fullPage: false });
        console.log('captured 08-dark-mode-rename-dialog.png');
      }
    }
  }

  await browser.close();
  console.log(`\nAll screenshots saved to ${OUT_DIR}/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
