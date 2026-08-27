// dump-pen-tree.ts — dump the raw .pen tree of the live document to see the
// panel node's declared height + clip flag vs children.
import { io } from 'socket.io-client';

const socket = io('http://localhost:3003', { path: '/', transports: ['websocket'], forceNew: true });
const done = await new Promise<void>((resolve) => {
  socket.on('connect', () => socket.emit('client', { type: 'subscribe', documentId: 'demo' }));
  socket.on('sync', (ev: any) => {
    if (ev?.type === 'canvas:full') {
      const doc = ev.document;
      const children = doc?.children ?? doc?.penTree ?? [];
      console.log(`doc keys: ${Object.keys(doc).join(', ')}`);
      console.log(`root children: ${children.length}`);
      const walk = (n: any, d: number) => {
        const pad = '  '.repeat(d);
        const geo = `x=${n.x ?? '?'} y=${n.y ?? '?'} w=${n.width ?? '?'} h=${n.height ?? '?'}${n.clip ? ' CLIP' : ''}`;
        const al = n.autoLayout ? ` [AL:${n.autoLayout.direction}/${n.autoLayout.alignY}]` : '';
        console.log(`${pad}${n.type} "${n.name}" ${geo}${al}${n.type === 'text' ? ` text="${String(n.text ?? '').slice(0, 22)}"` : ''}`);
        for (const c of n.children ?? []) walk(c, d + 1);
      };
      for (const c of children) walk(c, 0);
      resolve();
    }
  });
  setTimeout(() => resolve(), 6000);
});
try { socket.disconnect(); } catch { /* noop */ }
