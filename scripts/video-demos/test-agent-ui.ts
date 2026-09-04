// test-agent-ui.ts — visually test the agent's UI/UX generation across a range
// of real-world scenarios. For each prompt:
//   1. Load a fresh document (?doc=video-test-<timestamp>) so the canvas is empty
//   2. Submit the prompt via the browser (through the Caddy gateway on :81, so
//      Socket.IO works and patches reach the canvas)
//   3. Wait up to 60s for the agent to finish (detect completion via no-new-
//      tool-cards for 5s, or shape count stabilizing)
//   4. Screenshot the canvas
//   5. Log: prompt, time-to-first-shape, final shape count, shape types
//
// Run: bun run scripts/video-demos/test-agent-ui.ts
//
// Output: download/agent-ui-tests/<scenario>.png + a JSON summary

import { chromium, type Browser, type Page } from 'playwright-core';

const CHROME = '/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome';
const APP_URL = 'http://127.0.0.1:81/';
const OUT_DIR = '/home/z/my-project/download/agent-ui-tests';
const TIMEOUT_MS = 45_000;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

interface Scenario {
  id: string;
  prompt: string;
  description: string;
}

const SCENARIOS: Scenario[] = [
  {
    id: '01-mobile-login',
    prompt: 'Design a mobile login screen with email and password fields and a sign in button',
    description: 'Mobile login screen — the classic first test',
  },
  {
    id: '02-dashboard',
    prompt: 'Generate a dashboard wireframe with a sidebar, a header, 4 stat cards, and a chart area',
    description: 'Dashboard wireframe — multi-section layout',
  },
  {
    id: '03-pricing-3tier',
    prompt: 'Design a pricing page with 3 plan cards side by side, each with a name, price, and feature list',
    description: 'Pricing page with 3 tiers — repeated component',
  },
  {
    id: '04-navbar',
    prompt: 'Design a website navbar with a logo on the left and 4 menu items on the right',
    description: 'Navbar — horizontal layout with text + shapes',
  },
  {
    id: '05-onboarding-3screen',
    prompt: 'Design a 3-screen mobile onboarding flow: welcome, features, and get started screens side by side',
    description: 'Multi-screen onboarding flow — the headline use case',
  },
  {
    id: '06-product-card',
    prompt: 'Design a product card with an image area at top, a title, a price, and an add to cart button',
    description: 'Product card — vertical card layout',
  },
  {
    id: '07-hero-section',
    prompt: 'Design a hero section with a large headline, a subheadline, and two CTA buttons',
    description: 'Hero section — marketing landing page',
  },
  {
    id: '08-settings-page',
    prompt: 'Design a settings page with a left sidebar of categories and a main panel with toggle switches',
    description: 'Settings page — two-column layout',
  },
];

interface Result {
  id: string;
  prompt: string;
  description: string;
  timeToFirstShape: number | null;
  finalShapeCount: number;
  shapeTypes: string[];
  screenshotPath: string;
  agentEvents: number;
  error?: string;
}

async function runScenario(browser: Browser, scenario: Scenario): Promise<Result> {
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1200 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  // Capture console errors for debugging
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      const t = msg.text();
      if (t.includes('canvas-sync') || t.includes('socket') || t.includes('error')) {
        consoleErrors.push(t.slice(0, 200));
      }
    }
  });

  // Capture agent API responses to count events
  let agentEventCount = 0;
  page.on('response', async (res) => {
    if (res.url().includes('/api/agent')) {
      try {
        const text = await res.text();
        agentEventCount += (text.match(/"type":"agent_event"/g) || []).length;
      } catch {}
    }
  });

  const result: Result = {
    id: scenario.id,
    prompt: scenario.prompt,
    description: scenario.description,
    timeToFirstShape: null,
    finalShapeCount: 0,
    shapeTypes: [],
    screenshotPath: '',
    agentEvents: 0,
  };

  try {
    // Load a fresh document
    const docId = `ui-test-${scenario.id}-${Date.now()}`;
    await page.goto(`${APP_URL}?doc=${docId}`, { waitUntil: 'networkidle', timeout: 30_000 });
    await sleep(3000);
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.reload({ waitUntil: 'networkidle', timeout: 30_000 });
    await sleep(2000);

    // Type and submit the prompt
    const ta = page.locator('textarea').first();
    await ta.click();
    await sleep(200);
    await ta.fill(scenario.prompt);
    await sleep(500);
    await page.keyboard.press('Enter');

    // Wait for the agent to finish — poll shape count every 2s
    const startTime = Date.now();
    let lastShapeCount = 0;
    let stableSince = 0;
    let firstShapeTime: number | null = null;

    while (Date.now() - startTime < TIMEOUT_MS) {
      await sleep(2000);
      const shapeCount = await page.locator('[data-node-id]').count().catch(() => 0);
      if (shapeCount > 0 && firstShapeTime === null) {
        firstShapeTime = Date.now() - startTime;
        result.timeToFirstShape = firstShapeTime;
      }
      if (shapeCount === lastShapeCount && shapeCount > 0) {
        stableSince += 2000;
        if (stableSince >= 5000) break; // 5s of no new shapes = done
      } else {
        stableSince = 0;
        lastShapeCount = shapeCount;
      }
    }

    result.finalShapeCount = lastShapeCount;
    result.agentEvents = agentEventCount;

    // Collect shape types
    result.shapeTypes = await page.locator('[data-node-type]').evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-node-type') || '').filter(Boolean)
    ).catch(() => []);

    // Screenshot the canvas (full page to capture all panels)
    const screenshotPath = `${OUT_DIR}/${scenario.id}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: false });
    result.screenshotPath = screenshotPath;

    if (consoleErrors.length > 0) {
      result.error = consoleErrors.slice(0, 3).join(' | ');
    }
  } catch (e) {
    result.error = (e as Error).message;
  } finally {
    await ctx.close();
  }

  return result;
}

async function main() {
  const fs = await import('fs');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });

  const results: Result[] = [];
  for (const scenario of SCENARIOS) {
    console.log(`\n=== ${scenario.id}: ${scenario.description} ===`);
    console.log(`  prompt: "${scenario.prompt}"`);
    const result = await runScenario(browser, scenario);
    console.log(`  time-to-first-shape: ${result.timeToFirstShape ?? '—'}ms`);
    console.log(`  final shapes: ${result.finalShapeCount}`);
    console.log(`  shape types: [${result.shapeTypes.join(', ')}]`);
    console.log(`  agent events: ${result.agentEvents}`);
    if (result.error) console.log(`  ⚠ ${result.error}`);
    console.log(`  screenshot: ${result.screenshotPath}`);
    results.push(result);
  }

  await browser.close();

  // Write JSON summary
  fs.writeFileSync(`${OUT_DIR}/results.json`, JSON.stringify(results, null, 2));
  console.log(`\n=== Summary written to ${OUT_DIR}/results.json ===`);
  console.log('\nQuick stats:');
  for (const r of results) {
    const status = r.finalShapeCount > 0 ? '✓' : '✗';
    console.log(`  ${status} ${r.id}: ${r.finalShapeCount} shapes, ${(r.timeToFirstShape ?? 0) / 1000}s to first`);
  }
}

main().catch((e) => {
  console.error('test-agent-ui.ts failed:', e);
  process.exit(1);
});
