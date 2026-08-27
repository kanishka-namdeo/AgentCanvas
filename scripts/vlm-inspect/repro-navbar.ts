// repro-navbar.ts — apply clear + the ms-navbar t1 add_subtree patch with
// proper sequencing (wait for the canvas:full echo after subscribe, wait for
// patch echoes), then request a fresh full dump.
import { io } from 'socket.io-client';
import { readFileSync } from 'node:fs';

const events = readFileSync('/home/z/my-project/download/vlm-exercise/baseline/tap-events/ms-navbar-t1.jsonl', 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const patch = events
  .map((e) => e.event)
  .find((ev) => ev?.type === 'canvas:patch' && ev.patch?.op === 'add_subtree')?.patch;

if (!patch) { console.error('add_subtree patch not found'); process.exit(1); }

const socket = io('http://localhost:3003', { path: '/', transports: ['websocket'], forceNew: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await new Promise<void>((resolve) => {
  let step = 0;
  socket.on('connect', () => socket.emit('client', { type: 'subscribe', documentId: 'demo' }));
  socket.on('sync', async (ev: any) => {
    if (ev?.type === 'canvas:full' && step === 0) {
      step = 1;
      socket.emit('client', { type: 'canvas:patch', patch: { op: 'clear', summary: 'repro: clear' } });
      await sleep(600);
      socket.emit('client', { type: 'canvas:patch', patch });
      await sleep(1200);
      socket.emit('client', { type: 'canvas:request_full', documentId: 'demo' });
    } else if (ev?.type === 'canvas:full' && step === 1) {
      step = 2;
      const shapes = ev.document?.shapes ?? [];
      console.log(`final state: ${shapes.length} shapes`);
      for (const s of shapes) {
        console.log(`  ${String(s.type).padEnd(8)} "${String(s.name ?? '').slice(0, 26)}" x=${Math.round(s.x)} y=${Math.round(s.y)} w=${Math.round(s.width)} h=${Math.round(s.height)}`);
      }
      resolve();
    }
  });
  setTimeout(() => resolve(), 10_000);
});
try { socket.disconnect(); } catch { /* noop */ }
