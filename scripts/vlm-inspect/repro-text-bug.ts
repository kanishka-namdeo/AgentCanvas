// repro-text-bug.ts — inject the EXACT subtree the agent created for ms-navbar
// t1 (from the tap file) directly via the canvas-sync socket, then report the
// resulting canvas:full shape count. Screenshot + DOM inspection follow in
// separate calls.
import { io } from 'socket.io-client';
import { readFileSync } from 'node:fs';

const events = readFileSync('/home/z/my-project/download/vlm-exercise/baseline/tap-events/ms-navbar-t1.jsonl', 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const patch = events
  .map((e) => e.event)
  .find((ev) => ev?.type === 'canvas:patch' && ev.patch?.op === 'add_subtree')?.patch;

if (!patch) {
  console.error('add_subtree patch not found');
  process.exit(1);
}

const socket = io('http://localhost:3003', { path: '/', transports: ['websocket'], forceNew: true });
const result = await new Promise<void>((resolve) => {
  socket.on('connect', () => {
    socket.emit('client', { type: 'subscribe', documentId: 'demo' });
    setTimeout(() => {
      socket.emit('client', { type: 'canvas:patch', patch: { op: 'clear', summary: 'repro: clear' } });
      setTimeout(() => {
        socket.emit('client', { type: 'canvas:patch', patch });
        setTimeout(() => {
          socket.emit('client', { type: 'canvas:request_full', documentId: 'demo' });
        }, 800);
      }, 800);
    }, 400);
  });
  socket.on('sync', (ev: any) => {
    if (ev?.type === 'canvas:full') {
      const shapes = ev.document?.shapes ?? [];
      const texts = shapes.filter((s: any) => s.type === 'text');
      console.log(`shapes: ${shapes.length} | text shapes: ${texts.length}`);
      for (const t of texts.slice(0, 8)) {
        console.log(`  text "${String(t.text).slice(0, 24)}" x=${t.x} y=${t.y} w=${t.width} h=${t.height} color=${t.fill ?? t.color}`);
      }
      resolve();
    }
  });
  setTimeout(() => resolve(), 8000);
});
try { socket.disconnect(); } catch { /* noop */ }
