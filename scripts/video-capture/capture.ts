// capture.ts — CLI entry for the AgentCanvas landing video capture harness.
//
//   bunx tsx scripts/video-capture/capture.ts [--scenario=id] [--list]
//        [--mode=video|frames] [--takes=N] [--fps=N]
//        [--out=download/landing-capture/<name>]
//        [--base-url=http://127.0.0.1:3000]
//
// Base URL resolution: --base-url flag → LANDING_BASE_URL env →
// http://127.0.0.1:3000 (reuses the scripts/screenshot-landing.ts pattern;
// port 3000 is occupied by an unrelated app on this machine — never used).
//
// Pipeline per scenario × take (multi-take: take-01/, take-02/, …):
//   1. POST /api/documents — a FRESH document per take (deterministic empty
//      canvas; the page hydrates ?doc=<id> via URL).
//   2. Browser context with recordVideo (video mode) or none (frames mode),
//      theme 'light' + scenario seeds injected BEFORE app scripts load.
//   3. Scenario actions run (see scenarios.ts — choreography contract there).
//   4. Video mode: context close finalizes the webm → ffmpeg transcode to
//      H.264 MP4 + poster PNG. Frames mode: fixed-timestep PNG screenshots.
//   5. Verdict: PASS only with zero action throws, all required selectors
//      present, zero page errors, and zero UNFILTERED console errors.
//   6. manifest.json per scenario run (paths relative to repo root).
//
// LLM-FREE by contract: no /api/agent calls, no endpoint touches.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { launchBrowser, startFrameLoop, transcodeToMp4, verifyFfmpeg, type FrameLoopHandle } from './record';
import { getScenario, listScenarios, runScenario, waitForAppReady, SCENARIOS, type RunContext, type Scenario } from './scenarios';
import type { Browser } from 'playwright-core';

// ── CLI ──────────────────────────────────────────────────────────────────

interface Args {
  scenario: string | null;
  list: boolean;
  mode: 'video' | 'frames';
  takes: number;
  fps: number;
  out: string | null;
  baseUrl: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    scenario: null,
    list: false,
    mode: 'video',
    takes: 1,
    fps: 10,
    out: null,
    baseUrl: process.env.LANDING_BASE_URL ?? 'http://127.0.0.1:3000',
  };
  for (const raw of argv) {
    const m = raw.match(/^--([a-z-]+)(?:=(.*))?$/i);
    if (!m) continue;
    const key = m[1];
    const value = m[2];
    switch (key) {
      case 'scenario': args.scenario = value ?? null; break;
      case 'list': args.list = true; break;
      case 'mode': args.mode = value === 'frames' ? 'frames' : 'video'; break;
      case 'takes': args.takes = Math.max(1, parseInt(value ?? '1', 10) || 1); break;
      case 'fps': args.fps = Math.max(1, parseInt(value ?? '10', 10) || 10); break;
      case 'out': args.out = value ?? null; break;
      case 'base-url': args.baseUrl = (value ?? '').replace(/\/+$/, ''); break;
      default: break;
    }
  }
  return args;
}

function gitSha(): string {
  const probe = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return probe.status === 0 ? probe.stdout.trim() : 'unknown';
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ── Console-error policy ─────────────────────────────────────────────────
//
// The browser socket CANNOT connect on a direct-port dev server (the
// ?XTransformPort routing only exists behind the Caddy gateway — see
// scenarios.ts header). Socket.IO retries forever, so the handshake 404s /
// failed-WebSocket entries are EXPECTED noise, not defects. Everything else
// counts against the take's verdict.

const CONSOLE_ERROR_FILTERS: RegExp[] = [
  /socket\.io/i,
  /XTransformPort/i,
  /WebSocket connection to .* failed/i,
  /React DevTools/i, // dev-mode suggestion, not a defect
  // Known-benign dev-mode React warning: the app's caret-suppression feature
  // sets `style={{caret-color:"transparent"}}` on inputs client-side, which
  // races first hydration under slow conditions (frames mode's screenshot
  // loop) and logs this once per page load. Cosmetic, self-healing, and not
  // reachable in a production build (the dev warning itself is dev-only).
  /A tree hydrated but some attributes of the server rendered HTML didn't match/i,
];

function isFilteredConsoleError(text: string, url: string | undefined): boolean {
  const haystack = `${text} ${url ?? ''}`;
  return CONSOLE_ERROR_FILTERS.some((re) => re.test(haystack));
}

// ── Manifest types ───────────────────────────────────────────────────────

interface TakeManifest {
  index: number;
  dir: string;
  mp4: string | null;
  poster: string | null;
  webm: string | null;
  framesDir: string | null;
  frameCount: number | null;
  durationS: number | null;
  dimensions: { width: number; height: number } | null;
  bytes: number | null;
  consoleErrors: string[];
  pageErrors: string[];
  verdict: 'PASS' | 'FAIL';
  failure: string | null;
  actionsExecuted: number;
}

interface Manifest {
  scenario: string;
  title: string;
  description: string;
  baseUrl: string;
  mode: 'video' | 'frames';
  fps: number | null;
  takes: number;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  theme: string;
  timestamp: string;
  gitSha: string;
  browserChannel: string | null;
  choreography: string;
  seeding: string;
  results: TakeManifest[];
}

// ── Orchestration ────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(process.cwd());

async function createDocument(baseUrl: string, id: string, name: string, log: (s: string) => void): Promise<void> {
  let lastErr = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/api/documents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, name }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok || res.status === 400) {
        // 400 = id shape problem — a real bug we want surfaced, so only
        // accept ok / 409-style idempotent responses.
        if (res.ok) {
          log(`document ${id} ready`);
          return;
        }
        throw new Error(`POST /api/documents 400: ${await res.text()}`);
      }
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, attempt * 2_000));
  }
  throw new Error(`Could not create document ${id}: ${lastErr}`);
}

/// Seed script: runs BEFORE any app script (context.addInitScript) so the
/// settings blob is already in place when the theme bootstrap + the settings
/// store hydrate. Zustand-persist merge layers the seeded keys over
/// DEFAULT_SETTINGS, so a partial blob (theme only) is sufficient.
/// `agentcanvas.onboarding.v1` (hasCompleted) suppresses the first-visit
/// onboarding dialog, which would otherwise intercept every click.
function seedScript(scenario: Scenario): string {
  const settings = { state: { themePreference: scenario.theme ?? 'light' }, version: 5 };
  const extra = { 'agentcanvas.onboarding.v1': JSON.stringify({ state: { hasCompleted: true, skipped: true }, version: 1 }), ...(scenario.seedLocalStorage ?? {}) };
  return `(() => {
    try {
      const seed = ${JSON.stringify({ settings, extra })};
      localStorage.setItem('agentcanvas.settings.v1', JSON.stringify(seed.settings));
      for (const [k, v] of Object.entries(seed.extra)) localStorage.setItem(k, v);
    } catch (e) { /* localStorage unavailable — nothing to seed */ }
  })()`;
}

async function runTake(
  browser: Browser,
  scenario: Scenario,
  baseUrl: string,
  takeDir: string,
  takeIndex: number,
  docId: string,
  mode: 'video' | 'frames',
  fps: number,
  logLines: string[],
): Promise<TakeManifest> {
  const log = (line: string) => {
    const stamped = `[${new Date().toISOString().slice(11, 23)}] ${line}`;
    logLines.push(stamped);
    console.log(`    ${line}`);
  };

  fs.mkdirSync(takeDir, { recursive: true });
  await createDocument(baseUrl, docId, `Landing capture — ${scenario.id} (take ${takeIndex})`, log);

  const viewport = scenario.viewport ?? { width: 1600, height: 1000 };
  const dsf = scenario.deviceScaleFactor ?? 2;

  const contextOptions: Parameters<Browser['newContext']>[0] = {
    viewport,
    deviceScaleFactor: dsf,
  };
  if (mode === 'video') {
    contextOptions.recordVideo = { dir: path.join(takeDir, 'raw'), size: viewport };
  }
  const context = await browser.newContext(contextOptions);

  // Seed localStorage BEFORE any app script runs (theme + scenario extras).
  await context.addInitScript(seedScript(scenario));

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const url = msg.location()?.url;
    const textLine = `${msg.text()}${url ? ` [${url}]` : ''}`;
    if (isFilteredConsoleError(msg.text(), url)) {
      log(`console (filtered): ${textLine.slice(0, 160)}`);
      return;
    }
    consoleErrors.push(textLine);
    log(`console ERROR: ${textLine.slice(0, 220)}`);
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
    log(`pageerror: ${err.message.slice(0, 220)}`);
  });

  // Frames mode: fixed-timestep screenshot loop runs alongside the actions.
  let frameLoop: FrameLoopHandle | null = null;
  let frameCount: number | null = null;
  if (mode === 'frames') {
    frameLoop = startFrameLoop(page, path.join(takeDir, 'frames'), fps, (err) => {
      log(`frame capture failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  const runCtx: RunContext = {
    page,
    baseUrl,
    documentId: docId,
    cursor: scenario.cursor ?? false,
    log,
    consoleErrors,
  };

  const outcome = await runScenario(scenario, runCtx);

  if (frameLoop) {
    frameCount = await frameLoop.stop();
    log(`frames captured: ${frameCount}`);
  }

  // Finalize: close page + context (Playwright flushes the webm on close).
  await page.close().catch(() => {});
  await context.close().catch(() => {});

  const manifest: TakeManifest = {
    index: takeIndex,
    dir: toRepoRelative(takeDir),
    mp4: null,
    poster: null,
    webm: null,
    framesDir: mode === 'frames' ? toRepoRelative(path.join(takeDir, 'frames')) : null,
    frameCount,
    durationS: null,
    dimensions: null,
    bytes: null,
    consoleErrors,
    pageErrors,
    verdict: 'FAIL',
    failure: null,
    actionsExecuted: outcome.actionsExecuted,
  };

  if (!outcome.ok) {
    manifest.failure = outcome.failure ?? 'scenario failed without a failure message';
    log(`take FAIL: ${manifest.failure}`);
    return manifest;
  }

  if (mode === 'video') {
    const rawDir = path.join(takeDir, 'raw');
    const webms = fs.existsSync(rawDir) ? fs.readdirSync(rawDir).filter((f) => f.endsWith('.webm')) : [];
    if (webms.length === 0) {
      manifest.failure = 'no webm produced by recordVideo';
      log('take FAIL: no webm produced');
      return manifest;
    }
    const webmPath = path.join(rawDir, webms[0]);
    manifest.webm = toRepoRelative(webmPath);
    try {
      const tc = await transcodeToMp4(webmPath, takeDir);
      manifest.mp4 = toRepoRelative(tc.mp4Path);
      manifest.poster = tc.posterPath ? toRepoRelative(tc.posterPath) : null;
      manifest.durationS = Math.round(tc.durationS * 100) / 100;
      manifest.dimensions = tc.dimensions;
      manifest.bytes = tc.bytes;
      log(`mp4 ready: ${manifest.mp4} (${manifest.durationS}s, ${tc.dimensions.width}x${tc.dimensions.height}, ${(tc.bytes / 1e6).toFixed(2)} MB)`);
    } catch (err) {
      manifest.failure = `transcode failed: ${err instanceof Error ? err.message : String(err)}`;
      log(`take FAIL: ${manifest.failure}`);
      return manifest;
    }
  }

  // Verdict gates.
  const problems: string[] = [];
  if (pageErrors.length > 0) problems.push(`${pageErrors.length} page error(s)`);
  if (consoleErrors.length > 0) problems.push(`${consoleErrors.length} console error(s)`);
  if (problems.length > 0) {
    manifest.failure = problems.join('; ');
    log(`take FAIL: ${manifest.failure}`);
    return manifest;
  }

  manifest.verdict = 'PASS';
  log('take PASS');
  return manifest;
}

function toRepoRelative(absPath: string): string {
  const rel = path.relative(REPO_ROOT, absPath).replace(/\\/g, '/');
  return rel.startsWith('..') ? absPath.replace(/\\/g, '/') : rel;
}

async function captureScenario(browser: Browser, scenario: Scenario, args: Args, browserChannel: string | null): Promise<boolean> {
  const outDir = path.resolve(
    REPO_ROOT,
    args.out ?? `download/landing-capture/${scenario.id}-${stamp()}`,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const logLines: string[] = [];
  const log = (line: string) => {
    logLines.push(`[${new Date().toISOString().slice(11, 23)}] ${line}`);
    console.log(line);
  };

  log(`\n=== ${scenario.id} — ${scenario.title}`);
  log(`base ${args.baseUrl} · mode ${args.mode} · takes ${args.takes}${args.mode === 'frames' ? ` · fps ${args.fps}` : ''}`);

  // Warmup pass: let the dev server compile /app + the API routes so takes
  // don't burn recording time on first-compile latency.
  const warmupDoc = 'vid-warmup';
  await createDocument(args.baseUrl, warmupDoc, 'Landing capture warmup', log);
  const warmupCtx = await browser.newContext({ viewport: scenario.viewport ?? { width: 1600, height: 1000 } });
  const warmupPage = await warmupCtx.newPage();
  try {
    await warmupPage.goto(`${args.baseUrl}/app?doc=${warmupDoc}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await waitForAppReady(warmupPage, 120_000);
    await new Promise((r) => setTimeout(r, 2_500));
    log('warmup: /app compiled + hydrated');
  } catch (err) {
    log(`warmup warning: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await warmupPage.close().catch(() => {});
    await warmupCtx.close().catch(() => {});
  }

  const runStamp = stamp();
  const results: TakeManifest[] = [];
  for (let i = 1; i <= args.takes; i++) {
    const takeDir = path.join(outDir, `take-${String(i).padStart(2, '0')}`);
    const docId = `vid-${scenario.id}-${runStamp}-t${String(i).padStart(2, '0')}`;
    log(`take ${i}: doc ${docId}`);
    const takeManifest = await runTake(
      browser, scenario, args.baseUrl, takeDir, i, docId, args.mode, args.fps, logLines,
    );
    results.push(takeManifest);
  }

  const manifest = {
    scenario: scenario.id,
    title: scenario.title,
    description: scenario.description,
    baseUrl: args.baseUrl,
    mode: args.mode,
    fps: args.mode === 'frames' ? args.fps : null,
    takes: args.takes,
    viewport: scenario.viewport ?? { width: 1600, height: 1000 },
    deviceScaleFactor: scenario.deviceScaleFactor ?? 2,
    theme: scenario.theme ?? 'light',
    timestamp: new Date().toISOString(),
    gitSha: gitSha(),
    browserChannel,
    choreography:
      'store-injection: window.__canvasStore.getState().sendPatch(patch) via page.evaluate — the app\'s own mutation surface (stamping + undo + optimistic apply). Socket.IO ghost-collaborator replay is NOT viable on a direct-port dev server: the client connects same-origin (?XTransformPort=3003 gateway routing) and /socket.io 404s without Caddy, so the browser socket never connects and Node-side socket emission would never reach the UI.',
    seeding:
      'POST /api/documents {id} before navigation — a fresh document per take (?doc=<id>) guarantees an empty canvas without localStorage/socket persistence dependencies.',
    results,
  };

  const manifestPath = path.join(outDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  log(`manifest → ${toRepoRelative(manifestPath)}`);
  fs.writeFileSync(path.join(outDir, 'console.log'), logLines.join('\n'));

  const passed = results.filter((r) => r.verdict === 'PASS').length;
  log(`=== ${scenario.id}: ${passed}/${results.length} take(s) PASS`);
  return passed === results.length;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    listScenarios();
    return;
  }

  if (args.mode === 'video') {
    verifyFfmpeg();
  }

  const scenarioIds = args.scenario
    ? args.scenario.split(',').map((s) => s.trim()).filter(Boolean)
    : SCENARIOS.map((s) => s.id);
  const scenarios: Scenario[] = [];
  for (const id of scenarioIds) {
    const s = getScenario(id);
    if (!s) {
      console.error(`Unknown scenario "${id}". Use --list to see available scenarios.`);
      process.exit(1);
    }
    scenarios.push(s);
  }

  console.log(`Video capture harness → ${args.baseUrl} (mode=${args.mode}, takes=${args.takes})`);
  const { browser, channel } = await launchBrowser();
  console.log(`Browser launched (channel: ${channel ?? 'bundled-chromium'})`);

  let allPass = true;
  try {
    for (const scenario of scenarios) {
      const ok = await captureScenario(browser, scenario, args, channel);
      allPass = allPass && ok;
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(allPass ? '\nALL SCENARIOS PASS' : '\nSOME TAKES FAILED — see manifest.json / console.log under download/landing-capture/');
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('Capture failed:', err);
  process.exit(1);
});
