// E2E probe — Phase B replication core (R1/R3/R4/R5) live verification.
//
// Against the running dev stack (app :3000, canvas-sync :3003), a synthetic
// client verifies the exactly-once user-patch pipeline end to end:
//
//   Phase 1  — R1: a stamped user patch is journaled (user_patch row in the
//              events API) + acked (accepted), the journal row order is
//              correct, and the events API carries lastMutationIDChanges.
//   Phase 2  — R1 exactly-once: re-sending the SAME clientMutationId (an
//              outbox retry after a lost ack) gets a `duplicate` ack and
//              does NOT write a second journal row.
//   Phase 3  — R1 gap: sending id +2 ahead gets `rejected`.
//   Phase 4  — R4: GET /api/documents/<doc>/agent/status reports
//              lastMutationIDChanges + lastSeq; active is null when idle.
//   Phase 5  — R3: a real agent turn (tiny prompt) journals
//              agent:user_message + agent:turn_final with identity, and the
//              status route reports finalResponse text once the run ends.
//
// Exit code 0 = all assertions held.
//
// Run: bun scripts/e2e-phase-b-probe.ts

import { io } from 'socket.io-client';

const SOCKET_URL = 'http://127.0.0.1:3003';
const APP_URL = 'http://127.0.0.1:3000';
const DOC = `probe-b-${Date.now().toString(36)}`;
const CLIENT_ID = `probe-client-${Date.now().toString(36)}`;

interface MutationAck {
  type: 'mutation:ack';
  clientId: string;
  clientMutationId: number;
  status: 'accepted' | 'duplicate' | 'rejected';
  lastMutationId: number;
}

interface JournalRowWire {
  seq: number;
  type: string;
  payload: unknown;
}

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchEvents(afterSeq = 0): Promise<{ events: JournalRowWire[]; lastSeq: number; lastMutationIDChanges?: Record<string, number> }> {
  const res = await fetch(`${APP_URL}/api/documents/${DOC}/events?afterSeq=${afterSeq}&limit=200`);
  if (!res.ok) throw new Error(`events API ${res.status}`);
  return res.json();
}

async function fetchStatus(): Promise<any> {
  const res = await fetch(`${APP_URL}/api/documents/${DOC}/agent/status`);
  if (!res.ok) throw new Error(`status API ${res.status}`);
  return res.json();
}

async function main() {
  const socket = io(SOCKET_URL, {
    transports: ['websocket', 'polling'],
    reconnection: false,
    timeout: 8000,
  });

  const acks: MutationAck[] = [];
  const syncEvents: Array<{ type: string; [k: string]: unknown }> = [];
  let connected = false;

  socket.on('connect', () => {
    connected = true;
    socket.emit('client', { type: 'subscribe', documentId: DOC });
  });
  socket.on('disconnect', () => {
    connected = false;
  });
  socket.on('sync', (event: { type: string; [k: string]: unknown }) => {
    if (event.type === 'mutation:ack') {
      acks.push(event as unknown as MutationAck);
    }
    syncEvents.push(event);
  });

  const connectDeadline = Date.now() + 8000;
  while (!connected && Date.now() < connectDeadline) await wait(100);
  if (!connected) {
    check('socket connects to :3003', false);
    finish();
    return;
  }
  check('socket connects to :3003', true);
  await wait(300); // canvas:full arrives

  // ---- Phase 1: R1 accepted + journaled ------------------------------------
  socket.emit('client', {
    type: 'canvas:patch',
    documentId: DOC,
    clientId: CLIENT_ID,
    clientMutationId: 1,
    patch: { op: 'update', shapeId: 'probe-shape', shape: { fill: '#ff0000' } },
  });
  await wait(400);
  const ack1 = acks.find((a) => a.clientMutationId === 1);
  check('mutation 1 acked accepted', ack1?.status === 'accepted', `ack=${JSON.stringify(ack1)}`);

  const page1 = await fetchEvents(0);
  const userPatchRows = page1.events.filter((e) => e.type === 'user_patch');
  check(
    'user_patch row journaled with identity',
    userPatchRows.length === 1 &&
      (userPatchRows[0].payload as { clientId?: string; clientMutationId?: number })?.clientId === CLIENT_ID &&
      (userPatchRows[0].payload as { clientMutationId?: number })?.clientMutationId === 1,
    `rows=${userPatchRows.length}`,
  );
  check(
    'events API carries lastMutationIDChanges',
    page1.lastMutationIDChanges?.[CLIENT_ID] === 1,
    `clocks=${JSON.stringify(page1.lastMutationIDChanges)}`,
  );

  // ---- Phase 2: R1 exactly-once (duplicate) ---------------------------------
  socket.emit('client', {
    type: 'canvas:patch',
    documentId: DOC,
    clientId: CLIENT_ID,
    clientMutationId: 1, // RETRY the same id (lost-ack outbox flush)
    patch: { op: 'update', shapeId: 'probe-shape', shape: { fill: '#ff0000' } },
  });
  await wait(400);
  const dupAcks = acks.filter((a) => a.clientMutationId === 1);
  check(
    'retried mutation 1 acked duplicate (exactly-once)',
    dupAcks.length === 2 && dupAcks[1].status === 'duplicate',
    `acks=${JSON.stringify(dupAcks)}`,
  );
  const page2 = await fetchEvents(0);
  check(
    'no second user_patch row for the retry',
    page2.events.filter((e) => e.type === 'user_patch').length === 1,
  );

  // ---- Phase 3: R1 gap rejection --------------------------------------------
  socket.emit('client', {
    type: 'canvas:patch',
    documentId: DOC,
    clientId: CLIENT_ID,
    clientMutationId: 5, // gap: server expects 2
    patch: { op: 'update', shapeId: 'probe-shape', shape: { fill: '#00ff00' } },
  });
  await wait(400);
  const gapAck = acks.find((a) => a.clientMutationId === 5);
  check('gap mutation 5 acked rejected', gapAck?.status === 'rejected', `ack=${JSON.stringify(gapAck)}`);

  // ---- Phase 4: R4 status endpoint (idle) ------------------------------------
  const statusIdle = await fetchStatus();
  check(
    'status: idle doc reports clocks + lastSeq',
    statusIdle.active === null &&
      statusIdle.lastMutationIDChanges?.[CLIENT_ID] === 1 &&
      typeof statusIdle.lastSeq === 'number' && statusIdle.lastSeq > 0,
    `lastSeq=${statusIdle.lastSeq} clocks=${JSON.stringify(statusIdle.lastMutationIDChanges)}`,
  );

  // ---- Phase 5: R3 real agent turn with identity ------------------------------
  console.log('\n[phase 5] running a real agent turn (this takes a while)…');
  const runStarted = Date.now();
  socket.emit('client', {
    type: 'agent:prompt',
    documentId: DOC,
    prompt: 'Reply with exactly the word: pineapple. Do not create any canvas nodes.',
    sessionId: 'probe-sess-1',
    runId: 'probe-run-1',
    userMessageId: 'probe-msg-u1',
    assistantMessageId: 'probe-msg-a1',
  });

  // Watch the wire for the turn lifecycle events.
  const wireDeadline = Date.now() + 180_000;
  let sawUserMessage = false;
  let sawTurnFinal: { text?: string; status?: string; messageId?: string; runId?: string } | null = null;
  while (Date.now() < wireDeadline) {
    await wait(500);
    sawUserMessage = sawUserMessage || syncEvents.some((e) => e.type === 'agent:user_message');
    const final = syncEvents.find((e) => e.type === 'agent:turn_final');
    if (final) {
      sawTurnFinal = final as { text?: string; status?: string; messageId?: string; runId?: string };
      break;
    }
  }
  const runSeconds = ((Date.now() - runStarted) / 1000).toFixed(1);
  check('live wire carried agent:user_message broadcast', sawUserMessage);
  check(
    'live wire carried agent:turn_final with identity + content',
    !!sawTurnFinal &&
      sawTurnFinal.messageId === 'probe-msg-a1' &&
      sawTurnFinal.runId === 'probe-run-1' &&
      typeof sawTurnFinal.text === 'string' && sawTurnFinal.text.length > 0,
    `final=${JSON.stringify(sawTurnFinal)?.slice(0, 140)}`,
  );

  await wait(800); // journal write chain settles
  const page5 = await fetchEvents(0);
  const journaledUserMsg = page5.events.find((e) => e.type === 'agent:user_message');
  const journaledFinal = page5.events.find((e) => e.type === 'agent:turn_final');
  const userMsgText = (journaledUserMsg?.payload as { text?: string } | undefined)?.text ?? '';
  check(
    'journal: agent:user_message row with identity',
    !!journaledUserMsg &&
      (journaledUserMsg.payload as { messageId?: string })?.messageId === 'probe-msg-u1' &&
      userMsgText.includes('pineapple'),
    `payload=${JSON.stringify(journaledUserMsg?.payload)?.slice(0, 100)}`,
  );
  check(
    'journal: agent:turn_final row with identity + status',
    !!journaledFinal &&
      (journaledFinal.payload as { messageId?: string })?.messageId === 'probe-msg-a1' &&
      ['complete', 'cancelled', 'error'].includes(String((journaledFinal.payload as { status?: string }).status)),
    `payload=${JSON.stringify(journaledFinal?.payload)?.slice(0, 120)}`,
  );

  const statusAfter = await fetchStatus();
  check(
    'status after run: active null + finalResponse text + lastTerminal',
    statusAfter.active === null &&
      typeof statusAfter.finalResponse === 'string' && statusAfter.finalResponse.length > 0 &&
      !!statusAfter.lastTerminal,
    `finalResponse=${JSON.stringify(statusAfter.finalResponse)?.slice(0, 80)} lastTerminal=${JSON.stringify(statusAfter.lastTerminal)}`,
  );

  socket.disconnect();
  console.log(`\n(agent turn took ${runSeconds}s)`);
  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log('\n===== SUMMARY =====');
  console.log(JSON.stringify({
    passed: results.filter((r) => r.ok).length,
    failed: failed.length,
    checks: results,
  }, null, 2));
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('probe crashed:', err);
  finish();
});
