// replay-turn.ts — reconstruct a scenario turn's final canvas state by
// replaying every canvas:patch from the tap files (turn 1..N) onto a cleared
// canvas, then zoom-to-fit and screenshot. Used when a live screenshot was
// missed (browser crash) but the tap events survived.
//
// Usage: bun replay-turn.ts <passDir> <scenarioId> <turnNo>
import { io } from 'socket.io-client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const passDir = process.argv[2];
const scenarioId = process.argv[3];
const turnNo = Number(process.argv[4]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Gather patches from turn 1..turnNo in order.
const patches: any[] = [];
for (let t = 1; t <= turnNo; t++) {
  const file = join(passDir, 'tap-events', `${scenarioId}-t${t}.jsonl`);
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const ev = JSON.parse(line).event;
      if (ev?.type === 'canvas:patch' && ev.patch) patches.push(ev.patch);
    } catch { /* skip */ }
  }
}
console.log(`replaying ${patches.length} patches (${scenarioId} t1..t${turnNo})`);

const socket = io('http://localhost:3003', { path: '/', transports: ['websocket'], forceNew: true });
await new Promise<void>((resolve) => {
  socket.on('connect', () => socket.emit('client', { type: 'subscribe', documentId: 'demo' }));
  socket.on('sync', async (ev: any) => {
    if (ev?.type === 'canvas:full') {
      socket.emit('client', { type: 'canvas:patch', patch: { op: 'clear', summary: 'replay: clear' } });
      await sleep(800);
      for (const p of patches) {
        socket.emit('client', { type: 'canvas:patch', patch: p });
        await sleep(150);
      }
      await sleep(2500);
      resolve();
    }
  });
  setTimeout(() => resolve(), 20_000 + patches.length * 200);
});
try { socket.disconnect(); } catch { /* noop */ }

// Zoom to fit (Shift+1) then screenshot.
await sleep(1500);
try {
  execSync(`agent-browser press Shift+Digit1`, { timeout: 15_000 });
} catch { /* best effort */ }
await sleep(2000);
const out = join(passDir, `${scenarioId}-t${turnNo}.png`);
try {
  execSync(`agent-browser screenshot ${out}`, { timeout: 30_000 });
  console.log(`screenshot: ${out}`);
} catch (e) {
  console.error('screenshot failed:', (e as Error).message.slice(0, 120));
  process.exit(1);
}
