// Probe: what URL does the app's socket.io client actually request?
// Hooks WebSocket + fetch + XHR BEFORE the app boots, then prints traffic.
import { chromium } from 'playwright';

const URL = process.env.PROBE_URL || 'http://localhost:81';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

await page.addInitScript(() => {
  const log = (kind, url) => {
    try { console.log(`[PROBE] ${kind} ${url}`); } catch {}
  };
  const NativeWS = window.WebSocket;
  window.WebSocket = class extends NativeWS {
    constructor(url, ...rest) {
      log('WS', String(url));
      super(url, ...rest);
    }
  };
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const u = typeof input === 'string' ? input : (input && input.url);
      log('FETCH', String(u));
    } catch {}
    return nativeFetch.apply(this, arguments);
  };
  const nativeXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    log('XHR', String(url));
    return nativeXHROpen.apply(this, [method, url, ...rest]);
  };
});

page.on('console', (msg) => {
  const t = msg.text();
  if (t.includes('[PROBE]') || t.includes('canvas-sync')) console.log(`CONSOLE: ${t}`);
});

await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(6000);

// Also dump the socket.io client's own view: check for the sync indicator text.
const status = await page.evaluate(() => {
  const el = document.querySelector('[data-slot="status"], [role="status"]');
  return el ? el.textContent : null;
});
console.log('SYNC STATUS:', status);
await browser.close();
