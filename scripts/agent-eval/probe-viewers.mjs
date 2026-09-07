// Probe 4: monitor viewerCount over time (detect subscriber leaks).
import WebSocket from 'ws';

const URL = 'ws://localhost:3003/socket.io/?EIO=4&transport=websocket';
const ws = new WebSocket(URL);
const t0 = Date.now();

ws.on('message', (d, isBin) => {
  if (isBin) return;
  const s = d.toString();
  if (s.startsWith('0')) { ws.send('40'); return; }
  if (s.startsWith('2')) { ws.send('3'); return; }
  if (s.startsWith('40')) { ws.send('42["client",{"type":"subscribe","documentId":"demo"}]'); return; }
  if (s.startsWith('42')) {
    const m = s.match(/presence.*viewerCount":(\d+)/) || s.match(/"type":"presence","viewerCount":(\d+)/);
    if (m) console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s viewerCount=${m[1]}`);
  }
});
ws.on('error', (e) => console.log('ERR', e.message));

const DURATION = parseInt(process.env.DUR || '60', 10) * 1000;
setTimeout(() => { try { ws.close(); } catch {}; process.exit(0); }, DURATION);
