#!/usr/bin/env bun
// repro-followup-ws.ts — WS-path follow-up repro (mirrors the app's real flow).
//
// The app's primary path is the canvas-sync socket on :3003 — the client
// emits `client:agent:prompt` and the SERVER builds the /api/agent body,
// including the canvasDelta watermark (which the HTTP fallback never sends).
// This repro drives both turns through that exact path, then reports what
// the delta computation WOULD hand the follow-up turn.
//
// Usage: bun scripts/agent-eval/repro-followup-ws.ts

import { io } from 'socket.io-client';
import { computeChangedNodeIdsSince, getCheckpointSeq } from '../../src/lib/canvas/journal-fold';
import type { SyncEvent, CanvasPatch } from '../../src/lib/canvas/types';
import { agentRunSettings, DEFAULT_SETTINGS } from '../../src/lib/settings/types';

const DOC = `ws-repro-${Date.now().toString(36)}`;
const T1 = 'Create a login form on a 420x320 white card centered on the canvas: an "Email" input field, a "Password" input field, and a blue "Log in" button below them.';
const T2 = 'Change the button label to "Sign in" and make the button full-width to match the input fields.';
const TURN_TIMEOUT = 8 * 60 * 1000;

interface TurnLog {
  toolCalls: string[];
  messageText: string;
  patches: number;
  errors: string[];
}

function runTurnViaSocket(socket: any, prompt: string): Promise<TurnLog> {
  return new Promise((resolve, reject) => {
    const log: TurnLog = { toolCalls: [], messageText: '', patches: 0, errors: [] };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('turn timed out'));
    }, TURN_TIMEOUT);
    const onSync = (ev: SyncEvent) => {
      if (ev.type === 'agent:message_delta') log.messageText += ev.text;
      else if (ev.type === 'agent:tool_call_start') log.toolCalls.push(ev.toolName);
      else if (ev.type === 'agent:tool_call_end' && !ev.success) log.errors.push(`${ev.toolCallId}: ${ev.summary ?? ''}`.slice(0, 120));
      else if (ev.type === 'agent:error') log.errors.push(ev.message?.slice(0, 160) ?? '');
      else if (ev.type === 'canvas:patch') log.patches++;
      else if (ev.type === 'agent:turn_end' || ev.type === 'agent:turn_cancelled') {
        clearTimeout(timer);
        cleanup();
        resolve(log);
      }
    };
    const cleanup = () => socket.off('sync', onSync);
    socket.on('sync', onSync);
    socket.emit('client', {
      type: 'agent:prompt',
      documentId: DOC,
      prompt,
      settings: agentRunSettings({ ...DEFAULT_SETTINGS } as any),
    });
  });
}

const socket = io('http://localhost:3003', {
  transports: ['websocket', 'polling'],
  forceNew: true,
  reconnection: false,
  timeout: 10000,
});

await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('socket connect timeout')), 10000);
  socket.on('connect', () => { clearTimeout(t); resolve(); });
  socket.on('connect_error', (e: Error) => { clearTimeout(t); reject(e); });
});
console.log(`connected to :3003 as ${socket.id}`);
socket.emit('client', { type: 'subscribe', documentId: DOC });

console.log('\n=== TURN 1 (via WS) ===');
const l1 = await runTurnViaSocket(socket, T1);
console.log(`  tools: ${l1.toolCalls.join(', ') || '(none)'}`);
console.log(`  patches: ${l1.patches}, errors: ${l1.errors.join(' | ') || 'none'}`);
console.log(`  message: ${l1.messageText.slice(0, 160).replace(/\n/g, ' ')}`);

// Wait for the server's post-turn checkpoint (fire-and-forget) to land.
await new Promise((r) => setTimeout(r, 8000));
const checkpointSeq = await getCheckpointSeq(DOC);
console.log(`\nserver checkpoint lastSeq after turn 1: ${checkpointSeq}`);
if (checkpointSeq && checkpointSeq > 0) {
  const delta = await computeChangedNodeIdsSince(DOC, checkpointSeq);
  console.log(`delta nodeIds for turn 2: ${JSON.stringify(delta.nodeIds)}`);
  console.log(delta.nodeIds !== null && delta.nodeIds.length === 0
    ? '>>> CONFIRMED BUG: empty nodeIds array → runner picks DELTA digest with ZERO expanded nodes (fresh session never saw the canvas).'
    : '>>> delta non-empty/null — different behavior than predicted.');
} else {
  console.log('>>> no server checkpoint yet — lastTurnSeq stays 0, turn 2 would get FULL snapshot.');
}

console.log('\n=== TURN 2 (via WS, follow-up) ===');
const l2 = await runTurnViaSocket(socket, T2);
console.log(`  tools: ${l2.toolCalls.join(', ') || '(none)'}`);
console.log(`  patches: ${l2.patches}, errors: ${l2.errors.join(' | ') || 'none'}`);
console.log(`  message: ${l2.messageText.slice(0, 400).replace(/\n/g, ' ')}`);
const hydrations = l2.toolCalls.filter((t) => t === 'pen_get_metadata').length;
console.log(`  pen_get_metadata hydrations: ${hydrations}`);
if (l2.patches === 0) console.log('>>> follow-up produced NO patches (no-op)');
socket.disconnect();
process.exit(0);
