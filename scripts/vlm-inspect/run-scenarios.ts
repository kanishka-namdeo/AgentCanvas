// run-scenarios.ts — browser-driven scenario runner for the VLM exercise.
//
// Drives the REAL UI (agent-browser + the app through the Caddy gateway on
// :81, so the socket.io path is exercised) through the scenario matrix in
// scenarios.json. ONE TURN PER INVOCATION (the sandbox reaps background
// processes between tool calls, so everything must complete inside a single
// process lifetime). Bash calls cap at 10 min, but agent turns can exceed
// that (observed: 45 tool calls / ~11 min on kimi-k2-5); the runner is
// therefore RESUMABLE:
//
//   - Phase RUN:    clear canvas (turn 1) → submit prompt → tap events →
//                   wait for agent:turn_end. If seen: finalize (screenshot +
//                   manifest). If MAX_WAIT hit first: write an inFlight
//                   manifest entry + tap file, exit 0. (A bash timeout kill
//                   still leaves the inFlight record from the periodic
//                   flusher.)
//   - Phase FINISH: re-invoked with an inFlight entry → new tap → wait for
//                   turn_end (or stop-button-stable fallback) → screenshot,
//                   merge tap files, finalize.
//
// Turn-end detection is DEFINITIVE: the runner watches the socket tap for
// `agent:turn_end` (emitted by runner-native.ts only AFTER the mandatory
// design-critique loop finishes — the Stop button disappears during the
// critique gap, so it cannot be trusted alone). Fallback (turn_end missed
// across a tap gap): Stop button gone AND no canvas:patch for 60s.
//
// Canvas isolation: the app uses a SHARED canvas (New chat does NOT clear
// the document), so scenario turn 1 emits a socket patch {op:'clear'} right
// after clicking New chat — each scenario starts from an empty canvas.
//
// Usage:
//   bun scripts/vlm-inspect/run-scenarios.ts <outDir>                  # next pending turn (or finish in-flight)
//   bun scripts/vlm-inspect/run-scenarios.ts <outDir> --scenario=os-hero
//   bun scripts/vlm-inspect/run-scenarios.ts <outDir> --redo=os-hero:2  # re-run a turn
//
// Env overrides: MAX_WAIT (per-turn seconds, default 540), APP_URL (default
// http://localhost:81).

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';

const ROOT = '/home/z/my-project';
const SCENARIOS_FILE = join(ROOT, 'scripts/vlm-inspect/scenarios.json');
const OUT_DIR = resolveDir(process.argv[2]);
const SCENARIO_ARG = process.argv.find((a) => a.startsWith('--scenario='));
const REDO_ARG = process.argv.find((a) => a.startsWith('--redo='));
const APP_URL = process.env.APP_URL ?? 'http://localhost:81';
const MAX_WAIT_S = Number(process.env.MAX_WAIT ?? 540);
const SYNC_PORT = 3003;
const DOC_ID = 'demo';

const STOP_SEL = 'button[title="Stop the agent (Esc also works)"]';

interface Turn { prompt: string }
interface Scenario { id: string; type: 'one-shot' | 'multi-shot'; turns: Turn[] }
interface ManifestEntry {
  scenarioId: string;
  turn: number;
  prompt: string;
  startMs?: number;
  endMs?: number;
  durationMs?: number;
  screenshot: string;
  tapFile: string;
  toolCalls?: number;
  timedOut?: boolean;
  empty?: boolean;
  inFlight?: boolean;
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

// ---- in-process socket tap ------------------------------------------------------

interface TapEvent { t: number; event: Record<string, unknown> }

function startTap(): { socket: Socket; events: TapEvent[]; lastPatchMs: number } {
  const events: TapEvent[] = [];
  const tap = { socket: null as unknown as Socket, events, lastPatchMs: Date.now() };
  const socket = io(`http://localhost:${SYNC_PORT}`, {
    path: '/',
    transports: ['websocket', 'polling'],
    forceNew: true,
    reconnection: true,
    reconnectionAttempts: 20,
    reconnectionDelay: 2000,
  });
  tap.socket = socket;
  socket.on('connect', () => {
    socket.emit('client', { type: 'subscribe', documentId: DOC_ID });
  });
  socket.on('sync', (event: Record<string, unknown>) => {
    const type = event?.type;
    if (type === 'presence') return;
    if (type === 'canvas:patch') tap.lastPatchMs = Date.now();
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
  return tap;
}

function countToolCalls(events: TapEvent[]): number {
  return events.filter((e) => e.event.type === 'agent:tool_call_start').length;
}

function flushTap(tapFile: string, events: TapEvent[]): void {
  if (!events.length) return;
  appendFileSync(tapFile, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

/// Definitive turn end: agent:turn_end seen on the tap AFTER submission.
/// Fallback (turn_end missed across a tap gap): Stop button gone AND no
/// canvas:patch for 60s AND no new events for 60s.
async function waitTurnEnd(
  tap: { events: TapEvent[]; lastPatchMs: number },
  startMs: number,
): Promise<{ ended: boolean; via: string }> {
  const deadline = Date.now() + MAX_WAIT_S * 1000;
  let stopGoneSince = 0;
  while (Date.now() < deadline) {
    const sawTurnEnd = tap.events.some(
      (e) => e.event.type === 'agent:turn_end' && e.t >= startMs - 2000,
    );
    if (sawTurnEnd) {
      await sleep(3000); // settle for late patches/turn_end doubles
      return { ended: true, via: 'turn_end' };
    }
    const n = stopButtonCount();
    if (n !== 1) {
      if (!stopGoneSince) stopGoneSince = Date.now();
      const quietCanvas = Date.now() - tap.lastPatchMs > 60_000;
      const quietEvents = Date.now() - (tap.events[tap.events.length - 1]?.t ?? 0) > 60_000;
      if (Date.now() - stopGoneSince > 90_000 && quietCanvas && quietEvents) {
        return { ended: true, via: 'stop-stable' };
      }
    } else {
      stopGoneSince = 0;
    }
    await sleep(5000);
  }
  return { ended: false, via: 'timeout' };
}

// ---- manifest helpers -------------------------------------------------------------

function readManifest(path: string): ManifestEntry[] {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
}

function writeManifest(path: string, manifest: ManifestEntry[]): void {
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

// ---- main -------------------------------------------------------------------------

async function main() {
  const { scenarios } = JSON.parse(readFileSync(SCENARIOS_FILE, 'utf8')) as { scenarios: Scenario[] };
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(join(OUT_DIR, 'tap-events'), { recursive: true });
  const manifestPath = join(OUT_DIR, 'manifest.json');
  let manifest = readManifest(manifestPath);

  // ---- FINISH PHASE: an in-flight turn from a previous invocation ----
  const inFlightIdx = manifest.findIndex((m) => m.inFlight);
  if (inFlightIdx >= 0 && !REDO_ARG) {
    const entry = manifest[inFlightIdx];
    console.log(`↻ FINISH in-flight turn: ${entry.scenarioId} t${entry.turn} (started ${new Date(entry.startMs!).toISOString()})`);
    const tap = startTap();
    await sleep(2500);
    const { ended, via } = await waitTurnEnd(tap, entry.startMs ?? Date.now() - 60_000);
    await sleep(4000);
    const shot = join(OUT_DIR, `${entry.scenarioId}-t${entry.turn}.png`);
    abQuiet(['screenshot', shot]);
    flushTap(entry.tapFile, tap.events);
    try { tap.socket.disconnect(); } catch { /* already gone */ }

    // Merge tool calls across tap parts (dedupe by toolCallId).
    const seen = new Set<string>();
    let toolCalls = 0;
    if (existsSync(entry.tapFile)) {
      for (const line of readFileSync(entry.tapFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line).event;
          if (ev?.type === 'agent:tool_call_start' && ev.toolCallId && !seen.has(ev.toolCallId)) {
            seen.add(ev.toolCallId);
            toolCalls++;
          }
        } catch { /* malformed line */ }
      }
    }
    const endMs = Date.now();
    delete entry.inFlight;
    entry.endMs = endMs;
    entry.durationMs = endMs - (entry.startMs ?? endMs);
    entry.toolCalls = toolCalls;
    entry.timedOut = !ended;
    entry.empty = toolCalls === 0;
    entry.screenshot = shot;
    manifest[inFlightIdx] = entry;
    writeManifest(manifestPath, manifest);
    console.log(`  ${toolCalls} tool calls · ${(entry.durationMs / 1000).toFixed(0)}s total · ended=${ended} (${via}) · empty=${entry.empty}`);
    const total = scenarios.reduce((a, s) => a + s.turns.length, 0);
    console.log(`progress: ${manifest.filter((m) => !m.inFlight).length}/${total} turns done`);
    process.exit(0);
  }

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
      const doneTurns = new Set(manifest.filter((m) => m.scenarioId === sc.id && !m.inFlight).map((m) => m.turn));
      const next = sc.turns.findIndex((_, i) => !doneTurns.has(i + 1));
      if (next >= 0) { target = { sc, turnNo: next + 1, redo: false }; break; }
    }
    if (!target && !SCENARIO_ARG) {
      for (const sc of scenarios) {
        const doneTurns = new Set(manifest.filter((m) => m.scenarioId === sc.id && !m.inFlight).map((m) => m.turn));
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
  if (!url.includes('localhost') || !url.includes(':81')) {
    abQuiet(['open', APP_URL]);
    await sleep(6000);
  }
  // If an agent turn is somehow still running, wait it out first.
  for (let i = 0; i < 10 && stopButtonCount() === 1; i++) await sleep(5000);

  const tapFile = join(OUT_DIR, 'tap-events', `${sc.id}-t${turnNo}.jsonl`);
  if (redo || turnNo === 1) {
    // Start the tap file clean on redo/turn-1 (a stale file from an aborted
    // previous attempt would double-count tool calls).
    writeFileSync(tapFile, '');
  }

  // ---- fresh chat on scenario turn 1 (+ canvas clear: shared-canvas model) ----
  if (turnNo === 1) {
    abQuiet(['find', 'role', 'button', 'click', '--name', 'New chat']);
    await sleep(3500);
    // The canvas is SHARED across chats — clear it so each scenario's
    // screenshot contains only that scenario's shapes.
    const clearSocket = io(`http://localhost:${SYNC_PORT}`, {
      path: '/',
      transports: ['websocket'],
      forceNew: true,
    });
    await new Promise<void>((resolve) => {
      clearSocket.on('connect', () => {
        clearSocket.emit('client', { type: 'subscribe', documentId: DOC_ID });
        setTimeout(() => {
          clearSocket.emit('client', { type: 'canvas:patch', patch: { op: 'clear', summary: 'Cleared canvas' } });
          setTimeout(() => { try { clearSocket.disconnect(); } catch { /* noop */ } resolve(); }, 1500);
        }, 600);
      });
      setTimeout(() => { try { clearSocket.disconnect(); } catch { /* noop */ } resolve(); }, 8000);
    });
    await sleep(2500); // let the UI settle after the clear broadcast
  }

  // ---- run the turn with the tap listening ----
  const tap = startTap();
  await sleep(2500); // let the tap subscribe before the prompt fires

  const startMs = Date.now();
  submitPrompt(prompt);

  // Pending-entry bookkeeping BEFORE the long wait: if this process is killed
  // by the bash timeout, the inFlight record lets the next invocation finish
  // the turn (screenshot + tap merge).
  const shot = join(OUT_DIR, `${sc.id}-t${turnNo}.png`);
  const pending: ManifestEntry = {
    scenarioId: sc.id,
    turn: turnNo,
    prompt,
    startMs,
    screenshot: shot,
    tapFile,
    inFlight: true,
    ...(redo ? { redone: (manifest.find((m) => m.scenarioId === sc.id && m.turn === turnNo)?.redone ?? 0) + 1 } : {}),
  };
  manifest = manifest.filter((m) => !(m.scenarioId === sc.id && m.turn === turnNo));
  manifest.push(pending);
  writeManifest(manifestPath, manifest);

  const { ended, via } = await waitTurnEnd(tap, startMs);
  await sleep(4000);
  const endMs = Date.now();

  abQuiet(['screenshot', shot]);
  flushTap(tapFile, tap.events);
  try { tap.socket.disconnect(); } catch { /* already gone */ }

  const toolCalls = countToolCalls(tap.events);

  if (!ended) {
    // Leave the inFlight entry in the manifest; exit so a follow-up call can
    // finish the turn (bash calls cap below real turn durations).
    console.log(`  still running after ${MAX_WAIT_S}s — leaving in-flight; re-invoke to finish`);
    console.log(`  (partial capture: ${toolCalls}+ tool calls)`);
    process.exit(0);
  }

  delete pending.inFlight;
  pending.endMs = endMs;
  pending.durationMs = endMs - startMs;
  pending.toolCalls = toolCalls;
  pending.timedOut = false;
  pending.empty = toolCalls === 0;
  writeManifest(manifestPath, manifest);

  console.log(`  ${toolCalls} tool calls · ${((endMs - startMs) / 1000).toFixed(0)}s · ended via ${via} · empty=${toolCalls === 0}`);
  console.log(`  screenshot: ${shot}`);
  console.log(`  tap: ${tapFile}`);
  const total = scenarios.reduce((a, s) => a + s.turns.length, 0);
  console.log(`progress: ${manifest.filter((m) => !m.inFlight).length}/${total} turns done`);
}

main();
