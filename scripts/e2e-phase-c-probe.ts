// E2E probe — Phase C (R2 journal fold + checkpoints + tombstones; R9a delta
// context regression) live verification against the dev stack.
//
//   Phase A (default) — against the running stack:
//     1. canvas:full carries the tombstone lane (deletedIds, additive).
//     2. Two stamped user ADDs are journaled + acked; the events API reports
//        clocks AND the new compaction fields (snapshotSeq / oldestSeq).
//     3. A real agent turn completes (turn_final) → a SERVER checkpoint row
//        (source='server', lastSeq>0) lands; the events API's snapshotSeq
//        reports it.
//     4. A user REMOVE creates a live tombstone: a SECOND subscriber's
//        canvas:full carries the removed id in deletedIds.
//     5. State is written for phase B.
//
//   Phase B (--phase2, run AFTER restarting the dev server) — the restart
//   survival headline:
//     6. First subscriber post-restart → canvas:full is the JOURNAL FOLD
//        (checkpoint + tail): the user-added node SURVIVED the process
//        restart (pre-Phase-C it was lost — the in-memory doc re-seeded from
//        the newest client snapshot, which user edits never created).
//     7. The removed node stays deleted (fold replays the remove →
//        tombstone lane re-seeded → deletedIds rides canvas:full).
//     8. The MutationClock is durable: the next contiguous clientMutationId
//        is accepted (id continuity across the restart).
//     9. The events API reports the pre-restart checkpoint (snapshotSeq>0).
//    10. A second agent turn still completes on the folded canvas (R9a delta
//        context + fold-hydrated state regression guard) and writes a NEW
//        checkpoint with a HIGHER lastSeq.
//
// R9a's delta digest content itself is unit-tested (canvas-snapshot-delta);
// the live probe covers the end-to-end wiring (server → route → runner) by
// asserting the delta-carrying turn still works on the folded document.
//
// Exit code 0 = all assertions held.
//
// Run: bun scripts/e2e-phase-c-probe.ts          (phase A)
//      bun scripts/e2e-phase-c-probe.ts --phase2 (phase B, after restart)

import { io } from 'socket.io-client';
import { createClient } from '@libsql/client';
import { readFileSync, writeFileSync } from 'node:fs';

const SOCKET_URL = 'http://127.0.0.1:3003';
const APP_URL = 'http://127.0.0.1:3000';
const STATE_FILE = '/tmp/agentcanvas-phase-c-probe-state.json';
const PHASE2 = process.argv.includes('--phase2');

const DOC = PHASE2
  ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { doc: string }).doc
  : `probe-c-${Date.now().toString(36)}`;
const CLIENT_ID = PHASE2
  ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { clientId: string }).clientId
  : `probe-client-c-${Date.now().toString(36)}`;

const db = createClient({ url: 'file:/home/z/my-project/db/custom.db' });

interface MutationAck {
  type: 'mutation:ack';
  clientId: string;
  clientMutationId: number;
  status: 'accepted' | 'duplicate' | 'rejected';
  lastMutationId: number;
}

interface FullEvent {
  type: 'canvas:full';
  document: { children?: Array<{ id: string }> };
  deletedIds?: string[];
}

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchEvents(afterSeq = 0): Promise<{
  events: Array<{ seq: number; type: string; payload: unknown }>;
  lastSeq: number;
  lastMutationIDChanges?: Record<string, number>;
  snapshotSeq?: number | null;
  oldestSeq?: number | null;
}> {
  const res = await fetch(`${APP_URL}/api/documents/${DOC}/events?afterSeq=${afterSeq}&limit=200`);
  if (!res.ok) throw new Error(`events API ${res.status}`);
  return res.json();
}

async function newestServerCheckpoint(): Promise<{ id: string; lastSeq: number; tombstones: string | null } | null> {
  const rs = await db.execute(
    "SELECT id, lastSeq, tombstones FROM DocumentSnapshot WHERE documentId = ? AND source = 'server' ORDER BY createdAt DESC LIMIT 1",
    [DOC],
  );
  const row = rs.rows[0];
  if (!row) return null;
  return { id: String(row.id), lastSeq: Number(row.lastSeq), tombstones: row.tombstones ? String(row.tombstones) : null };
}

function sendMutation(socket: ReturnType<typeof io>, id: number, patch: Record<string, unknown>) {
  socket.emit('client', {
    type: 'canvas:patch',
    documentId: DOC,
    clientId: CLIENT_ID,
    clientMutationId: id,
    patch,
  });
}

async function runAgentTurn(socket: ReturnType<typeof io>, prompt: string, tag: string, syncEvents: Array<{ type: string; [k: string]: unknown }>) {
  socket.emit('client', {
    type: 'agent:prompt',
    documentId: DOC,
    prompt,
    sessionId: `probe-c-sess-${tag}`,
    runId: `probe-c-run-${tag}`,
    userMessageId: `probe-c-msg-u-${tag}`,
    assistantMessageId: `probe-c-msg-a-${tag}`,
  });
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    await wait(500);
    const final = syncEvents.find((e) => e.type === 'agent:turn_final');
    if (final) return final as { text?: string; status?: string };
  }
  return null;
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
  socket.on('sync', (event: { type: string; [k: string]: unknown }) => {
    if (event.type === 'mutation:ack') acks.push(event as unknown as MutationAck);
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
  await wait(400); // canvas:full arrives

  const full = syncEvents.find((e) => e.type === 'canvas:full') as FullEvent | undefined;

  if (!PHASE2) {
    // ---- Phase A -------------------------------------------------------------
    check(
      'A1: canvas:full carries the tombstone lane (deletedIds array, additive)',
      Array.isArray(full?.deletedIds),
      `deletedIds=${JSON.stringify(full?.deletedIds)}`,
    );

    sendMutation(socket, 1, {
      op: 'add', shapeId: 'probe-node-a',
      shape: { type: 'rectangle', x: 120, y: 120, width: 60, height: 60, fill: '#ff0000' },
    });
    sendMutation(socket, 2, {
      op: 'add', shapeId: 'probe-node-b',
      shape: { type: 'rectangle', x: 220, y: 120, width: 60, height: 60, fill: '#00aa88' },
    });
    await wait(600);
    check('A2: both user ADDs acked accepted',
      acks.find((a) => a.clientMutationId === 1)?.status === 'accepted' &&
      acks.find((a) => a.clientMutationId === 2)?.status === 'accepted',
      `acks=${JSON.stringify(acks)}`);

    const page1 = await fetchEvents(0);
    check('A3: events API carries compaction fields (snapshotSeq/oldestSeq)',
      'snapshotSeq' in page1 && 'oldestSeq' in page1,
      `snapshotSeq=${page1.snapshotSeq} oldestSeq=${page1.oldestSeq}`);
    check('A4: user_patch rows journaled with identity',
      page1.events.filter((e) => e.type === 'user_patch').length >= 2 &&
      page1.lastMutationIDChanges?.[CLIENT_ID] === 2,
      `clocks=${JSON.stringify(page1.lastMutationIDChanges)}`);

    console.log('\n[A5] running a real agent turn (this takes a while)…');
    const final1 = await runAgentTurn(
      socket,
      'Reply with exactly the word: pineapple. Do not create any canvas nodes.',
      '1',
      syncEvents,
    );
    check('A5: agent turn completed (turn_final on the wire)',
      !!final1 && typeof final1.text === 'string' && final1.text.length > 0,
      `final=${JSON.stringify(final1)?.slice(0, 120)}`);

    // Turn-boundary checkpoint: fires in the run's finally + quiescence probe.
    let ckpt: Awaited<ReturnType<typeof newestServerCheckpoint>> = null;
    for (let i = 0; i < 40; i++) {
      await wait(500);
      ckpt = await newestServerCheckpoint();
      if (ckpt && ckpt.lastSeq > 0) break;
    }
    check('A6: SERVER checkpoint row written at the turn boundary (source=server, lastSeq>0)',
      !!ckpt && ckpt.lastSeq > 0,
      `ckpt=${JSON.stringify(ckpt)}`);

    const page2 = await fetchEvents(0);
    check('A7: events API snapshotSeq reports the checkpoint',
      typeof page2.snapshotSeq === 'number' && page2.snapshotSeq > 0,
      `snapshotSeq=${page2.snapshotSeq}`);

    // Live tombstone: a remove + a second subscriber sees deletedIds.
    sendMutation(socket, 3, { op: 'remove', shapeId: 'probe-node-b' });
    await wait(500);
    check('A8: remove acked accepted', acks.find((a) => a.clientMutationId === 3)?.status === 'accepted');

    const socket2 = io(SOCKET_URL, { transports: ['websocket', 'polling'], reconnection: false, timeout: 8000 });
    const full2 = await new Promise<FullEvent | undefined>((resolve) => {
      socket2.on('connect', () => socket2.emit('client', { type: 'subscribe', documentId: DOC }));
      socket2.on('sync', (event: { type: string; [k: string]: unknown }) => {
        if (event.type === 'canvas:full') resolve(event as unknown as FullEvent);
      });
      setTimeout(() => resolve(undefined), 8000);
    });
    socket2.disconnect();
    check('A9: second subscriber\u2019s canvas:full tombstones the removed node',
      Array.isArray(full2?.deletedIds) && full2!.deletedIds!.includes('probe-node-b'),
      `deletedIds=${JSON.stringify(full2?.deletedIds)}`);
    check('A10: second subscriber still sees the surviving node',
      !!full2?.document.children?.some((c) => c.id === 'probe-node-a'),
      `kids=${JSON.stringify(full2?.document.children?.map((c) => c.id))}`);

    const preRestart = await fetchEvents(0);
    writeFileSync(STATE_FILE, JSON.stringify({
      doc: DOC,
      clientId: CLIENT_ID,
      preRestartLastSeq: preRestart.lastSeq,
      preRestartSnapshotSeq: preRestart.snapshotSeq ?? null,
    }, null, 2));
    console.log(`\n[phase A done] state → ${STATE_FILE}`);
    console.log('NOW RESTART THE DEV SERVER, then run: bun scripts/e2e-phase-c-probe.ts --phase2');
  } else {
    // ---- Phase B (post-restart) ----------------------------------------------
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as {
      doc: string; clientId: string; preRestartLastSeq: number; preRestartSnapshotSeq: number | null;
    };

    check('B1: post-restart canvas:full is the JOURNAL FOLD — user-added node SURVIVED the restart',
      !!full?.document.children?.some((c) => c.id === 'probe-node-a'),
      `kids=${JSON.stringify(full?.document.children?.map((c) => c.id))}`);
    check('B2: the removed node stays deleted (tombstone lane re-seeded by the fold)',
      Array.isArray(full?.deletedIds) && full!.deletedIds!.includes('probe-node-b'),
      `deletedIds=${JSON.stringify(full?.deletedIds)}`);

    const page = await fetchEvents(0);
    check('B3: events API reports the pre-restart checkpoint (snapshotSeq>0)',
      typeof page.snapshotSeq === 'number' && page.snapshotSeq > 0,
      `snapshotSeq=${page.snapshotSeq} (pre-restart: ${state.preRestartSnapshotSeq})`);
    check('B4: journal head is at or past the pre-restart head',
      page.lastSeq >= state.preRestartLastSeq,
      `lastSeq=${page.lastSeq} (pre-restart: ${state.preRestartLastSeq})`);

    // Durable MutationClock: the next contiguous id is accepted.
    sendMutation(socket, 4, {
      op: 'add', shapeId: 'probe-node-c',
      shape: { type: 'rectangle', x: 320, y: 120, width: 60, height: 60, fill: '#3366cc' },
    });
    await wait(500);
    check('B5: mutation-clock continuity — next contiguous id accepted post-restart',
      acks.find((a) => a.clientMutationId === 4)?.status === 'accepted',
      `ack=${JSON.stringify(acks.find((a) => a.clientMutationId === 4))}`);

    console.log('\n[B6] running a second agent turn on the FOLDED canvas (delta context path)…');
    const final2 = await runAgentTurn(
      socket,
      'Reply with exactly the word: mango. Do not create any canvas nodes.',
      '2',
      syncEvents,
    );
    check('B6: agent turn on the folded canvas completed (delta-context + fold regression guard)',
      !!final2 && typeof final2.text === 'string' && final2.text.length > 0,
      `final=${JSON.stringify(final2)?.slice(0, 120)}`);

    let postCkpt: Awaited<ReturnType<typeof newestServerCheckpoint>> = null;
    for (let i = 0; i < 40; i++) {
      await wait(500);
      postCkpt = await newestServerCheckpoint();
      if (postCkpt && postCkpt.lastSeq > (page.lastSeq ?? 0)) break;
    }
    check('B7: a NEW server checkpoint landed with a higher lastSeq',
      !!postCkpt && postCkpt.lastSeq > (page.lastSeq ?? 0),
      `ckpt=${JSON.stringify(postCkpt)} (head at subscribe: ${page.lastSeq})`);
  }

  socket.disconnect();
  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${PHASE2 ? 'Phase B' : 'Phase A'}: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length > 0) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('probe crashed:', err);
  process.exit(1);
});
