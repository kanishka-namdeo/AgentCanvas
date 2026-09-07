// Probe 5: is the sessions blob already wiped on disk BEFORE app code runs?
import { chromium } from 'playwright';

const URL = 'http://localhost:81';

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

// Capture localStorage at the earliest possible point (before any app script).
await page.addInitScript(() => {
  try {
    const raw = window.localStorage.getItem('agentcanvas.sessions.v1');
    if (!raw) {
      window.__blobAtBoot = 'MISSING';
      return;
    }
    const parsed = JSON.parse(raw);
    const st = parsed?.state || {};
    window.__blobAtBoot = JSON.stringify({
      version: parsed?.version,
      msgKeys: Object.keys(st.messages || {}).length,
      runKeys: Object.keys(st.runs || {}).length,
      sessions: Object.keys(st.sessions || {}).length,
    });
  } catch (e) {
    window.__blobAtBoot = 'ERR:' + e.message;
  }
});

// Block the app's own JS from running long enough? Not possible — but we read
// the captured value immediately after load and again after 5s.
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
const atBoot = await page.evaluate(() => window.__blobAtBoot);
console.log('BLOB AT DOCUMENT-START:', atBoot);

await page.waitForTimeout(5000);
const after5s = await page.evaluate(() => {
  try {
    const raw = window.localStorage.getItem('agentcanvas.sessions.v1');
    const parsed = raw ? JSON.parse(raw) : null;
    const st = parsed?.state || {};
    return JSON.stringify({
      msgKeys: Object.keys(st.messages || {}).length,
      runKeys: Object.keys(st.runs || {}).length,
      sessions: Object.keys(st.sessions || {}).length,
      active: st.activeSessionByDoc,
    });
  } catch (e) { return 'ERR:' + e.message; }
});
console.log('BLOB AFTER 5s OF APP:', after5s);

// also inspect the in-memory zustand state via React? Not exposed. But check
// the server-side truth for comparison.
await browser.close();
