// dump-canvas.ts — request canvas:full and dump the resolved layer list with
// geometry, so we can see exactly what the renderer had to draw.
import { io } from 'socket.io-client';

const socket = io('http://localhost:3003', { path: '/', transports: ['websocket'], forceNew: true });
const done = await new Promise<void>((resolve) => {
  let fulls = 0;
  socket.on('connect', () => {
    socket.emit('client', { type: 'subscribe', documentId: 'demo' });
  });
  socket.on('sync', (ev: any) => {
    if (ev?.type === 'canvas:full') {
      fulls++;
      const shapes = ev.document?.shapes ?? [];
      console.log(`canvas:full #${fulls} — ${shapes.length} shapes`);
      for (const s of shapes) {
        console.log(
          `  ${String(s.type).padEnd(8)} "${String(s.name ?? '').slice(0, 28)}" x=${Math.round(s.x)} y=${Math.round(s.y)} w=${Math.round(s.width)} h=${Math.round(s.height)}` +
          (s.type === 'text' ? ` text="${String(s.text ?? '').slice(0, 20)}" color=${s.fill ?? s.color}` : ''),
        );
      }
      if (fulls >= 1) { resolve(); }
    }
  });
  setTimeout(() => resolve(), 6000);
});
try { socket.disconnect(); } catch { /* noop */ }
