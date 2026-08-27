// run-scenarios.ts — browser-driven scenario runner for the VLM exercise.
//
// Drives the REAL UI (agent-browser + the app through the Caddy gateway on
// :81, so the socket.io path is exercised) through the scenario matrix in
// scenarios.json. Designed for ONE TURN PER INVOCATION (the sandbox reaps
// background processes between tool calls, so everything must complete
// inside a single process lifetime):
//
//   - Reads manifest.json to find the next pending (scenario, turn)
//   - Starts an in-process socket.io tap (subscribes to the document on
//     :3003) so every agent event of the turn is captured
//   - Ensures the browser is on the app; clicks "New chat" on scenario turn 1
//   - Submits the prompt, waits for the turn to finish (Stop button gone)
//   - Screenshots the canvas, flushes the turn's tap events to
//     tap-events/<scenarioId>-t<turn>.jsonl, updates manifest.json
//
// Usage:
//   bun scripts/vlm-inspect/run-scenarios.ts <outDir>                  # next pending turn
//   bun scripts/vlm-inspect/run-scenarios.ts <outDir> --scenario=os-hero
//   bun scripts/vlm-inspect/run-scenarios.ts <outDir> --redo=os-hero:2  # re-run a turn
//
// Env overrides: MAX_WAIT (per-turn seconds, default 240), APP_URL (default
// http://localhost:81).

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';

const ROOT = '/home/z/my-project';
const SCENARIOS_FILE = join(ROOT, 'scripts/vlm-inspect/scenarios.json');
const OUT_DIR = resolveDir(process.argv[2]);
const SCENARIO_ARG = process.argv.find((a) => a.startsWith('--scenario='));
const REDO_ARG = process.argv.find((a) => a.startsWith('--redo='));
const APP_URL = process.env.APP_URL ?? 'http://localhost:81';
const MAX_WAIT_S = Number(process.env.MAX_WAIT ?? 240);
const SYNC_PORT = 3003;
const DOC_ID = 'demo';

const STOP_SEL = 'button[title="Stop the agent (Esc also works)"]';

interface Turn { prompt: string }
interface Scenario { id: string; type: 'one-shot' | 'multi-shot'; turns: Turn[] }
interface ManifestEntry {
  scenarioId: string;
  turn: number;
  prompt: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  screenshot: string;
  tapFile: string;
  toolCalls: number;
  timedOut: boolean;
  empty: boolean;
  redone?: number;
}

function resolveDir(arg?: string): string {
  if (!arg) return join(ROOT, 'download/vlm-exercise/baseline');
  return arg.startsWith('/') ? arg : join(ROOT, arg);
}

// ---- agent-browser helpers ----------------------------------------------------

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function ab(args: string[], timeoutMs = 30_000): string {
  return execSync(`agent-browser ${args.map(shq).join(' ')}`, {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

function abQuiet(args: string[]): void {
  try { ab(args); } catch { /* best-effort UI automation */ }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stopButtonCount(): number {
  try {
    const out = ab(['get', 'count', STOP_SEL]).trim();
    const n = Number(out.replace(/[^0-9]/g, ''));
    return Number.isFinite(n) ? n : -1;
  } catch {
    return -1;
  }
}

function currentUrl(): string {
  try { return ab(['get', 'url']).trim(); } catch { return ''; }
}

function submitPrompt(prompt: string): void {
  const sel = 'textarea[placeholder*="Ask the agent"]';
  try {
    ab(['fill', sel, prompt]);
  } catch {
    const json = JSON.stringify(prompt);
    ab(['eval', `(() => { const t = document.querySelector('textarea'); if (!t) return 'no-textarea'; const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; s.call(t, ${json}); t.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`]);
  }
  sleep(1200);
  abQuiet(['press', 'Enter']);
}

/// Wait until the agent turn finishes (Stop button gone, double-checked).
async function waitTurnEnd(): Promise<boolean> {
  const deadline = Date.now() + MAX_WAIT_S * 1000;
  while (Date.now() < deadline) {
    const n = stopButtonCount();
    if (n !== 1) {
      await sleep(6000);
      if (stopButtonCount() !== 1) return true;
    }
    await sleep(4000);
  }
  return false;
}

// ---- in-process socket tap ------------------------------------------------------

interface TapEvent { t: number; event: Record<string, unknown> }

function startTap(): { socket: Socket; events: TapEvent[] } {
  const events: TapEvent[] = [];
  const socket = io(`http://localhost:${SYNC_PORT}`, {
    path: '/',
    transports: ['websocket', 'polling'],
    forceNew: true,
    reconnection: true,
    reconnectionAttempts: 20,
    reconnectionDelay: 2000,
  });
  socket.on('connect', () => {
    socket.emit('client', { type: 'subscribe', documentId: DOC_ID });
  });
  socket.on('sync', (event: Record<string, unknown>) => {
    const type = event?.type;
    if (type === 'presence') return;
    if (type === 'canvas:full') {
      const doc = (event as { document?: { shapes?: unknown[] } }).document;
      events.push({ t: Date.now(), event: { type: 'canvas:full', shapeCount: doc?.shapes?.length ?? -1 } });
      return;
    }
    if (type === 'agent:message_delta') {
      events.push({ t: Date.now(), event: { type: 'agent:message_delta', len: String((event as { text?: string }).text ?? '').length } });
      return;
    }
    events.push({ t: Date.now(), event });
  });
  return { socket, events };
}

// ---- main -------------------------------------------------------------------------

async function main() {
  const { scenarios } = JSON.parse(readFileSync(SCENARIOS_FILE, 'utf8')) as { scenarios: Scenario[] };
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(join(OUT_DIR, 'tap-events'), { recursive: true });
  const manifestPath = join(OUT_DIR, 'manifest.json');
  let manifest: ManifestEntry[] = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : [];

  // ---- decide which turn to run ----
  let target: { sc: Scenario; turnNo: number; redo: boolean } | null = null;
  if (REDO_ARG) {
    const [id, turnStr] = REDO_ARG.split('=')[1].split(':');
    const sc = scenarios.find((s) => s.id === id);
    const turnNo = Number(turnStr);
    if (!sc || !turnNo || turnNo < 1 || turnNo > sc.turns.length) {
      console.error(`bad --redo target: ${REDO_ARG}`);
      process.exit(2);
    }
    target = { sc, turnNo, redo: true };
  } else {
    const candidates = SCENARIO_ARG
      ? scenarios.filter((s) => s.id === SCENARIO_ARG.split('=')[1])
      : scenarios;
    for (const sc of candidates) {
      const doneTurns = new Set(manifest.filter((m) => m.scenarioId === sc.id).map((m) => m.turn));
      const next = sc.turns.findIndex((_, i) => !doneTurns.has(i + 1));
      if (next >= 0) { target = { sc, turnNo: next + 1, redo: false }; break; }
    }
    // If all candidates are done, fall through to any pending scenario.
    if (!target && !SCENARIO_ARG) {
      for (const sc of scenarios) {
        const doneTurns = new Set(manifest.filter((m) => m.scenarioId === sc.id).map((m) => m.turn));
        const next = sc.turns.findIndex((_, i) => !doneTurns.has(i + 1));
        if (next >= 0) { target = { sc, turnNo: next + 1, redo: false }; break; }
      }
    }
  }

  if (!target) {
    console.log('ALL TURNS COMPLETE');
    console.log(`manifest: ${manifestPath} (${manifest.length} entries)`);
    process.exit(0);
  }

  const { sc, turnNo, redo } = target;
  const prompt = sc.turns[turnNo - 1].prompt;
  console.log(`▶ ${sc.id} turn ${turnNo}/${sc.turns.length}${redo ? ' (REDO)' : ''}: "${prompt.slice(0, 80)}…"`);

  // ---- ensure browser is on the app ----
  const url = currentUrl();
  if (!url.includes('localhost')) {
    abQuiet(['open', APP_URL]);
    await sleep(6000);
  } else if (!url.includes(':81')) {
    // Reload through the gateway so the socket.io path is used.
    abQuiet(['open', APP_URL]);
    await sleep(6000);
  }
  // If an agent turn is somehow still running, wait it out first.
  for (let i = 0; i < 10 && stopButtonCount() === 1; i++) await sleep(5000);

  // ---- fresh canvas/chat on scenario turn 1 ----
  if (turnNo === 1) {
    abQuiet(['find', 'role', 'button', 'click', '--name', 'New chat']);
    await sleep(3500);
  }

  // ---- run the turn with the tap listening ----
  const tap = startTap();
  await sleep(2500); // let the tap subscribe before the prompt fires

  const startMs = Date.now();
  submitPrompt(prompt);
  const ended = await waitTurnEnd();
  // Small settle so late events (turn_end, final patches) still land.
  await sleep(4000);
  const endMs = Date.now();

  const shot = join(OUT_DIR, `${sc.id}-t${turnNo}.png`);
  abQuiet(['screenshot', shot]);

  const toolCalls = tap.events.filter(
    (e) => (e.event as { type?: string }).type === 'agent:tool_call_start' && e.t >= startMs - 1000,
  ).length;

  const tapFile = join(OUT_DIR, 'tap-events', `${sc.id}-t${turnNo}.jsonl`);
  writeFileSync(tapFile, tap.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  try { tap.socket.disconnect(); } catch { /* already gone */ }

  const entry: ManifestEntry = {
    scenarioId: sc.id,
    turn: turnNo,
    prompt,
    startMs,
    endMs,
    durationMs: endMs - startMs,
    screenshot: shot,
    tapFile,
    toolCalls,
    timedOut: !ended,
    empty: toolCalls === 0,
  };
  if (redo) entry.redone = (manifest.find((m) => m.scenarioId === sc.id && m.turn === turnNo)?.redone ?? 0) + 1;

  manifest = manifest.filter((m) => !(m.scenarioId === sc.id && m.turn === turnNo));
  manifest.push(entry);
  manifest.sort((a, b) =>
    a.scenarioId === b.scenarioId ? a.turn - b.turn : a.scenarioId.localeCompare(b.scenarioId),
  );
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`  ${toolCalls} tool calls · ${((endMs - startMs) / 1000).toFixed(0)}s · timedOut=${!ended} · empty=${toolCalls === 0}`);
  console.log(`  screenshot: ${shot}`);
  console.log(`  tap: ${tapFile}`);
  const total = scenarios.reduce((a, s) => a + s.turns.length, 0);
  console.log(`progress: ${manifest.length}/${total} turns done`);
}

main();
