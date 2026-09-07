// Probe 3: connect as a real subscriber, dump presence/viewerCount + roster.
import WebSocket from 'ws';

const URL = process.env.PROBE_WS || 'ws://localhost:3003/socket.io/?EIO=4&transport=websocket';
const ws = new WebSocket(URL);
const seen = [];
const t0 = Date.now();

ws.on('open', () => {});
ws.on('message', (d, isBin) => {
  if (isBin) return;
  const s = d.toString();
  if (s.startsWith('0')) { ws.send('40'); return; }
  if (s.startsWith('2')) { ws.send('3'); return; }
  if (s.startsWith('40')) {
    // socket.io connect ACK → subscribe to demo document like the app does
    ws.send('42["client",{"type":"subscribe","documentId":"demo"}]');
    return;
  }
  if (s.startsWith('42')) {
    seen.push(`+${Date.now() - t0}ms ${s.slice(0, 200)}`);
  }
});

ws.on('error', (e) => console.log('ERR', e.message));
ws.on('close', (c) => console.log('CLOSED', c));

setTimeout(() => {
  console.log('=== events seen after subscribe ===');
  for (const line of seen.slice(0, 20)) console.log(line);
  try { ws.close(); } catch {}
  process.exit(0);
}, 3000);
