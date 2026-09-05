// Direct socket.io client test: subscribe to doc 'demo' on canvas-sync :3003
// and inspect the canvas:full payload.
import { io } from 'socket.io-client';

const socket = io('http://localhost:3003', { path: '/', transports: ['websocket'] });

const timeout = setTimeout(() => { console.log('TIMEOUT — no canvas:full received'); process.exit(1); }, 10000);

socket.on('connect', () => {
  console.log('connected:', socket.id);
  socket.emit('client', { type: 'subscribe', documentId: 'demo' });
});

socket.on('sync', (ev: any) => {
  if (ev?.type === 'canvas:full') {
    clearTimeout(timeout);
    const doc = ev.document ?? {};
    console.log('canvas:full reason:', ev.reason);
    console.log('docName:', doc.name);
    console.log('shapes:', (doc.shapes ?? []).length);
    console.log('shapeNames:', (doc.shapes ?? []).slice(0, 8).map((s: any) => s.name || s.type));
    process.exit(0);
  }
});

socket.on('connect_error', (e: any) => { console.log('connect_error:', e.message); });
