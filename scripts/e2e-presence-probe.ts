// E2E presence probe: a synthetic SECOND VIEWER connects to canvas-sync :3003,
// subscribes to the 'demo' document, and streams presence updates (cursor +
// selection + idle). The real browser (first viewer) must render the remote
// cursor overlay. Also exercises the steer round-trip (expects rejection
// when no agent run is active).
//
// Usage: bun scripts/e2e-presence-probe.ts

import { io } from 'socket.io-client';

const socket = io('http://127.0.0.1:3003', {
  transports: ['websocket', 'polling'],
  reconnection: false,
  timeout: 8000,
});

const seen: string[] = [];
let rosterSeen = false;
let steerRejected: string | null = null;

socket.on('connect', () => {
  console.log('[probe] connected:', socket.id);
  socket.emit('client', { type: 'subscribe', documentId: 'demo' });
  // Announce the second viewer.
  socket.emit('client', {
    type: 'presence:update',
    documentId: 'demo',
    participant: {
      participantId: 'p-probe-e2e',
      name: 'E2E Probe',
      color: '#8b5cf6',
      cursor: { x: 260, y: 180 },
      selection: [],
      idle: false,
    },
  });
  // Steer with no active run → expect agent:steer_rejected back to sender.
  socket.emit('client', { type: 'agent:steer', documentId: 'demo', text: 'e2e steer probe' });
});

socket.on('sync', (event: { type: string; roster?: unknown[]; participant?: { participantId?: string }; reason?: string; viewerCount?: number }) => {
  seen.push(event.type);
  if (event.type === 'presence:roster') {
    rosterSeen = true;
    console.log('[probe] roster:', JSON.stringify(event.roster));
  }
  if (event.type === 'canvas:full') {
    console.log('[probe] canvas:full reason =', event.reason ?? '(none)');
  }
  if (event.type === 'presence') {
    console.log('[probe] viewerCount =', event.viewerCount);
  }
  if (event.type === 'agent:steer_rejected') {
    steerRejected = 'yes';
    console.log('[probe] steer REJECTED as expected (no active run)');
  }
  // Relay the browser's presence updates (cursor from viewer 1).
  if (event.type === 'presence:update' && event.participant?.participantId?.startsWith('p-')) {
    console.log('[probe] saw browser presence:', JSON.stringify(event.participant).slice(0, 140));
  }
});

// Move the cursor a few times (throttle test happens browser-side; here we
// just relocate after a delay so the overlay visibly moves if screenshotted).
setTimeout(() => {
  socket.emit('client', {
    type: 'presence:update',
    documentId: 'demo',
    participant: {
      participantId: 'p-probe-e2e',
      name: 'E2E Probe',
      color: '#8b5cf6',
      cursor: { x: 420, y: 300 },
      selection: [],
      idle: true,
    },
  });
  console.log('[probe] cursor moved + idle');
}, 2500);

setTimeout(() => {
  const summary = {
    sawRoster: rosterSeen,
    steerRejected,
    eventTypes: [...new Set(seen)],
  };
  console.log('[probe] SUMMARY:', JSON.stringify(summary, null, 2));
  socket.disconnect();
  process.exit(steerRejected && rosterSeen ? 0 : 1);
}, 6000);

socket.on('connect_error', (err: Error) => {
  console.error('[probe] connect error:', err.message);
});
