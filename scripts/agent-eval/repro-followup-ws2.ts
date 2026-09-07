#!/usr/bin/env bun
// repro-followup-ws2.ts — 3-turn WS-path scenario (pricing iterate):
// build → visual emphasis edit → additive edit. Exercises follow-up turns
// of every kind through the app's primary (socket) path.

import { io } from 'socket.io-client';
import type { SyncEvent, CanvasDocument, CanvasPatch, Shape } from '../../src/lib/canvas/types';
import { applyPatchToCanvas } from '../../src/lib/canvas/patch';
import { agentRunSettings, DEFAULT_SETTINGS } from '../../src/lib/settings/types';

const DOC = `ws-repro2-${Date.now().toString(36)}`;
const TURNS: Array<{ label: string; prompt: string }> = [
  {
    label: 'T1 build',
    prompt:
      "Design a pricing page for a SaaS called 'Flowly' with 3 tiers: Starter $9/month, Pro $29/month, Enterprise $99/month. Include feature lists and CTA buttons for each tier.",
  },
  { label: 'T2 re-style (emphasis)', prompt: 'Make the Pro tier visually highlighted as the most popular option.' },
  { label: 'T3 additive', prompt: 'Add a monthly/yearly billing toggle at the top of the page.' },
];

const TURN_TIMEOUT = 8 * 60 * 1000;

function runTurnViaSocket(socket: any, prompt: string, canvasIn: CanvasDocument) {
  return new Promise<{ tools: string[]; message: string; patches: number; errors: string[]; canvas: CanvasDocument }>(
    (resolve, reject) => {
      let canvas = canvasIn;
      const tools: string[] = [];
      const errors: string[] = [];
      let message = '';
      let patches = 0;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('turn timed out'));
      }, TURN_TIMEOUT);
      const onSync = (ev: SyncEvent & { patch?: CanvasPatch }) => {
        if (ev.type === 'agent:message_delta') message += ev.text;
        else if (ev.type === 'agent:tool_call_start') tools.push(ev.toolName);
        else if (ev.type === 'agent:tool_call_end' && !ev.success) errors.push(`${ev.toolCallId}: ${ev.summary ?? ''}`.slice(0, 120));
        else if (ev.type === 'agent:error') errors.push(ev.message?.slice(0, 160) ?? '');
        else if (ev.type === 'canvas:patch' && ev.patch) {
          try {
            canvas = applyPatchToCanvas(canvas, ev.patch);
            patches++;
          } catch { /* counted as error below */ }
        } else if (ev.type === 'agent:turn_end' || ev.type === 'agent:turn_cancelled') {
          clearTimeout(timer);
          cleanup();
          resolve({ tools, message, patches, errors, canvas });
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
    },
  );
}

function textContent(doc: CanvasDocument): string {
  return (doc.shapes ?? []).map((s: Shape) => (s as any).text ?? '').join(' ').toLowerCase();
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
socket.emit('client', { type: 'subscribe', documentId: DOC });

let finalCanvas: CanvasDocument = { id: DOC, name: 'r2', version: 1, children: [], shapes: [] } as never;
for (const t of TURNS) {
  console.log(`\n=== ${t.label} ===`);
  const r = await runTurnViaSocket(socket, t.prompt, finalCanvas);
  finalCanvas = r.canvas;
  console.log(`  patches: ${r.patches}, tools: ${r.tools.length}, errors: ${r.errors.join(' | ') || 'none'}`);
  console.log(`  hydrations (pen_get_metadata): ${r.tools.filter((x) => x === 'pen_get_metadata').length}`);
  console.log(`  message: ${r.message.slice(0, 180).replace(/\n/g, ' ')}`);
  console.log(`  shapes: ${(r.canvas.shapes ?? []).length}`);
  await new Promise((res) => setTimeout(res, 4000));
}

// Assertions (subset of MULTISHOT ms-pricing-iterate)
const content = textContent(finalCanvas);
const texts = (finalCanvas!.shapes ?? []).filter((s) => s.type === 'text');
const p9 = /\b9\b/.test(texts.map((t: any) => t.text ?? '').join(' '));
const p29 = /\b29\b/.test(texts.map((t: any) => t.text ?? '').join(' '));
const p99 = /\b99\b/.test(texts.map((t: any) => t.text ?? '').join(' '));
const popular = content.includes('popular');
const toggle = content.includes('monthly') || content.includes('yearly') || content.includes('annual');

console.log('\n=== ASSERTIONS ===');
console.log(`prices survive all turns — 9:${p9} 29:${p29} 99:${p99}`);
console.log(`T2 Pro emphasis — 'popular' text:${popular}`);
console.log(`T3 billing toggle — monthly/yearly text:${toggle}`);
const pass = p9 && p29 && p99 && popular && toggle;
console.log(pass ? '✓ SCENARIO PASS' : '✗ SCENARIO FAIL');

socket.disconnect();
process.exit(pass ? 0 : 1);
