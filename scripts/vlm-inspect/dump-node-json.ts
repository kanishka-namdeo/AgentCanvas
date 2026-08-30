// dump-node-json.ts — print raw JSON of the first root child (the settings panel).
import { io } from 'socket.io-client';

const socket = io('http://localhost:3003', { path: '/', transports: ['websocket'], forceNew: true });
const done = await new Promise<void>((resolve) => {
  socket.on('connect', () => socket.emit('client', { type: 'subscribe', documentId: 'demo' }));
  socket.on('sync', (ev: any) => {
    if (ev?.type === 'canvas:full') {
      const panel = ev.document?.children?.[0];
      const { children, ...rest } = panel;
      console.log('PANEL KEYS/VALUES (sans children):');
      console.log(JSON.stringify(rest, null, 1).slice(0, 1800));
      console.log('\nFIRST CHILD (Panel Title) raw:');
      const c0 = children[0];
      console.log(JSON.stringify(c0, null, 1).slice(0, 900));
      resolve();
    }
  });
  setTimeout(() => resolve(), 6000);
});
try { socket.disconnect(); } catch { /* noop */ }
