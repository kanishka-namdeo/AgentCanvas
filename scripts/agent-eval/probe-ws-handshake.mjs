// Probe 2: full engine.io handshake over WS through the gateway.
import WebSocket from 'ws';

const URL = process.env.PROBE_WS || 'ws://localhost:81/socket.io/?XTransformPort=3003&EIO=4&transport=websocket';
const DIRECT = 'ws://localhost:3003/socket.io/?EIO=4&transport=websocket';

async function testHandshake(label, url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const frames = [];
    const to = setTimeout(() => {
      console.log(`${label}: TIMEOUT — open=${ws.OPEN === ws.readyState ? 'yes' : 'no'}, frames=${frames.length ? frames.join(' | ') : 'NONE'}`);
      try { ws.close(); } catch {}
      resolve();
    }, 6000);
    ws.on('open', () => frames.push('OPEN'));
    ws.on('message', (d) => {
      const s = d.toString().slice(0, 80);
      frames.push(s);
      // If we got the engine.io OPEN packet, reply with socket.io connect + probe ping
      if (s.startsWith('0')) {
        ws.send('40'); // socket.io namespace connect
      }
      if (s.startsWith('2')) ws.send('3'); // ping → pong
    });
    ws.on('error', (e) => { frames.push('ERR:' + e.message); });
    ws.on('close', (c, r) => {
      clearTimeout(to);
      console.log(`${label}: CLOSED code=${c} reason=${r ? r.toString().slice(0, 60) : ''} frames=${frames.join(' | ')}`);
      resolve();
    });
    setTimeout(() => {
      if (frames.length > 3) { // got open + handshake + something
        clearTimeout(to);
        console.log(`${label}: OK frames=${frames.join(' | ')}`);
        try { ws.close(); } catch {}
        resolve();
      }
    }, 5000);
  });
}

console.log('--- via gateway :81 ---');
await testHandshake('GATEWAY', URL);
console.log('--- direct :3003 ---');
await testHandshake('DIRECT', DIRECT);
process.exit(0);
