// Unit tests — variant promote (designer-workflow-parity spec §4.3):
//   (a) pure swap: swapVariantWithMain moves the parked variant to the active
//       page root and wraps the previous main design as a labeled section
//       appended to Explorations;
//   (b) fold round-trip: hydrateDocumentFromJournal on a journal containing a
//       `variant_promote` row reproduces the swapped document; tombstones
//       contain the removed ids; idempotent vs a following `document_restore`
//       row (both orders produce correct state);
//   (c) route: 409 with an active run, 404 unknown sectionId, 400 bad body,
//       200 success shape `{ ok, document }`.
//
// TEST STRATEGY (per src/lib/canvas/AGENTS.md): the fold + route tests share
// a REAL throwaway SQLite (the journal-fold.test.ts pattern — raw CREATE
// TABLE + process.env.DATABASE_URL at module scope). event-journal is mocked
// at module scope (the fold's foldTail reads from the mock; the route's
// appendSyntheticJournalEvent writes to it). run-registry uses its real API
// (pure module, no DB). variant-promote and journal-fold are NOT mocked —
// the route exercises the real implementations against the temp DB.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { unlinkSync } from 'node:fs';

const TMP_DB = `/tmp/agentcanvas-variant-promote-test-${process.pid}-${Date.now()}.db`;
const PREV_DB_URL = process.env.DATABASE_URL;
process.env.DATABASE_URL = `file:${TMP_DB}`;

const stateFold = vi.hoisted(() => ({
  rows: [] as Array<{
    documentId: string;
    seq: number;
    type: string;
    toolCallId: string | null;
    payload: unknown;
    createdAt: Date;
  }>,
}));

vi.mock('@/lib/agent/event-journal', () => ({
  getJournalEvents: vi.fn(async (documentId: string, afterSeq: number, limit: number) =>
    stateFold.rows
      .filter((r) => r.documentId === documentId && r.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map((r) => ({ ...r })),
  ),
  getJournalLastSeq: vi.fn(async (documentId: string) =>
    stateFold.rows
      .filter((r) => r.documentId === documentId)
      .reduce((m, r) => Math.max(m, r.seq), 0),
  ),
  getJournalOldestSeq: vi.fn(async () => null),
  deleteJournalRowsUpTo: vi.fn(async () => 0),
  appendSyntheticJournalEvent: vi.fn(
    (documentId: string, type: string, toolCallId: string | undefined, payload: unknown) => {
      const seq =
        stateFold.rows
          .filter((r) => r.documentId === documentId)
          .reduce((m, r) => Math.max(m, r.seq), 0) + 1;
      stateFold.rows.push({
        documentId,
        seq,
        type,
        toolCallId: toolCallId ?? null,
        payload: JSON.parse(JSON.stringify(payload)),
        createdAt: new Date(),
      });
    },
  ),
  flushJournal: vi.fn(async () => {}),
}));

import { NextRequest } from 'next/server';
import { POST as promotePOST } from '@/app/api/documents/[documentId]/variants/promote/route';
import {
  hydrateDocumentFromJournal,
  emptyDocument,
  collectAllNodeIds,
} from '@/lib/canvas/journal-fold';
import {
  swapVariantWithMain,
  applyVariantPromotePayload,
  type VariantPromotePayload,
} from '@/lib/canvas/variant-promote';
import type { CanvasDocument } from '@/lib/canvas/types';
import type { PenChild, PenPage } from '@/lib/pen/types';
import { db } from '@/lib/db';
import {
  registerActiveRun,
  __clearRunRegistryForTests,
} from '@/lib/canvas/run-registry';

const DOC = 'doc-promote';

function seedRow(type: string, payload: unknown, documentId = DOC): number {
  const seq =
    stateFold.rows
      .filter((r) => r.documentId === documentId)
      .reduce((m, r) => Math.max(m, r.seq), 0) + 1;
  stateFold.rows.push({ documentId, seq, type, toolCallId: null, payload, createdAt: new Date() });
  return seq;
}

/// Build a document with an active page + an Explorations page carrying parked
/// sections. Each parked section has a single child = the variant root.
function buildParkedDoc(args: {
  mainRoots: PenChild[];
  parkedSections: Array<{ id: string; label: string; variantRoot: PenChild }>;
}): CanvasDocument {
  const mainPage: PenPage = {
    id: 'page-main',
    name: 'Page 1',
    children: args.mainRoots,
  };
  const explorationsPage: PenPage = {
    id: 'page-exp',
    name: 'Explorations',
    children: args.parkedSections.map(
      (s) =>
        ({
          id: s.id,
          type: 'section',
          name: s.label,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          children: [s.variantRoot],
        }) as unknown as PenChild,
    ),
  };
  const doc = emptyDocument(DOC);
  (doc as CanvasDocument).pages = [mainPage, explorationsPage];
  (doc as CanvasDocument).activePageIndex = 0;
  (doc as CanvasDocument).children = args.mainRoots;
  return doc;
}

async function insertCheckpoint(doc: CanvasDocument, lastSeq: number, id: string): Promise<void> {
  await db.documentSnapshot.create({
    data: {
      id,
      documentId: DOC,
      document: JSON.stringify(doc),
      source: 'server',
      nodeCount: collectAllNodeIds(doc).length,
      lastSeq,
      tombstones: '[]',
      label: 'test checkpoint',
    },
  });
}

function routeParams(documentId: string) {
  return { params: Promise.resolve({ documentId }) };
}
function jsonRequest(body: unknown, documentId = DOC) {
  return new NextRequest(`http://localhost/api/documents/${documentId}/variants/promote`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeAll(async () => {
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "DocumentSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT,
    "runId" TEXT,
    "documentId" TEXT NOT NULL,
    "document" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'turn_end',
    "nodeCount" INTEGER NOT NULL DEFAULT 0,
    "bookmarked" BOOLEAN NOT NULL DEFAULT false,
    "lastSeq" INTEGER,
    "tombstones" TEXT,
    "label" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AgentEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "toolCallId" TEXT,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "AgentEvent_documentId_seq_key"
    ON "AgentEvent"("documentId", "seq")`);
});

afterAll(async () => {
  await db.$disconnect();
  if (PREV_DB_URL !== undefined) process.env.DATABASE_URL = PREV_DB_URL;
  else delete process.env.DATABASE_URL;
  try {
    unlinkSync(TMP_DB);
  } catch {
    /* best effort */
  }
});

beforeEach(async () => {
  stateFold.rows.length = 0;
  await db.documentSnapshot.deleteMany({});
  await db.agentEvent.deleteMany({});
  __clearRunRegistryForTests();
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  await db.documentSnapshot.deleteMany({});
});

// =========================================================================
// (a) Pure swap
// =========================================================================

describe('swapVariantWithMain (pure)', () => {
  it('moves the variant to the active page + wraps previous roots into a labeled section on Explorations', () => {
    const mainRoots: PenChild[] = [
      { id: 'main-root-1', type: 'frame', x: 50, y: 60, width: 100, height: 100 } as unknown as PenChild,
      { id: 'main-root-2', type: 'frame', x: 200, y: 60, width: 100, height: 100 } as unknown as PenChild,
    ];
    const variantRoot = {
      id: 'variant-root-A',
      type: 'frame',
      x: 0,
      y: 0,
      width: 300,
      height: 300,
    } as unknown as PenChild;
    const doc = buildParkedDoc({
      mainRoots,
      parkedSections: [
        { id: 'sec-A', label: 'Variant A — 8', variantRoot },
        {
          id: 'sec-B',
          label: 'Variant B — 6',
          variantRoot: { id: 'other', type: 'frame' } as unknown as PenChild,
        },
      ],
    });

    const result = swapVariantWithMain(doc, 'sec-A');
    expect(result).not.toBeNull();
    const { document, payload } = result!;

    // Active page children = [variantRoot] (the promoted variant).
    const activePage = document.pages![document.activePageIndex!];
    expect(activePage.children.map((c) => c.id)).toEqual(['variant-root-A']);
    // doc.children mirrors the active page.
    expect(document.children.map((c: { id: string }) => c.id)).toEqual(['variant-root-A']);

    // Explorations page: sec-A removed; a new "Previous — applied design" section appended,
    // wrapping the previous main roots.
    const expPage = document.pages!.find((p) => p.name.toLowerCase().includes('explorations'))!;
    const expIds = expPage.children.map((c) => c.id);
    expect(expIds).not.toContain('sec-A');
    expect(expIds).toContain('sec-B');
    const prevSection = expPage.children.find(
      (c) => (c as { name?: string }).name === 'Previous — applied design',
    ) as PenChild | undefined;
    expect(prevSection).toBeDefined();
    expect((prevSection as { children?: PenChild[] }).children?.map((c) => c.id)).toEqual([
      'main-root-1',
      'main-root-2',
    ]);

    // Payload shape.
    expect(payload.promotedSectionId).toBe('sec-A');
    expect(payload.promotedRoot.id).toBe('variant-root-A');
    expect(payload.previousMainRoots.map((r) => r.id)).toEqual(['main-root-1', 'main-root-2']);
    expect(payload.removedSectionIds).toContain('sec-A');
  });

  it('returns null when the section is not parked', () => {
    const doc = buildParkedDoc({
      mainRoots: [{ id: 'r', type: 'frame' } as unknown as PenChild],
      parkedSections: [
        {
          id: 'sec-A',
          label: 'Variant A',
          variantRoot: { id: 'v', type: 'frame' } as unknown as PenChild,
        },
      ],
    });
    expect(swapVariantWithMain(doc, 'no-such-section')).toBeNull();
  });

  it('returns null when no Explorations page exists', () => {
    const doc = emptyDocument(DOC);
    (doc as CanvasDocument).pages = [{ id: 'p', name: 'Page 1', children: [] }];
    (doc as CanvasDocument).activePageIndex = 0;
    expect(swapVariantWithMain(doc, 'sec-A')).toBeNull();
  });
});

// =========================================================================
// applyVariantPromotePayload (fold primitive)
// =========================================================================

describe('applyVariantPromotePayload (fold primitive)', () => {
  it('reconstructs the same document the pure swap produced', () => {
    const mainRoots: PenChild[] = [
      { id: 'main-1', type: 'frame', x: 10, y: 10, width: 50, height: 50 } as unknown as PenChild,
    ];
    const variantRoot = {
      id: 'variant-X',
      type: 'frame',
      x: 0,
      y: 0,
      width: 200,
      height: 200,
    } as unknown as PenChild;
    const doc = buildParkedDoc({
      mainRoots,
      parkedSections: [{ id: 'sec-X', label: 'Variant X', variantRoot }],
    });

    const swapped = swapVariantWithMain(doc, 'sec-X')!;
    // Apply the SAME payload to the ORIGINAL doc — must produce the identical
    // document shape.
    const reapplied = applyVariantPromotePayload(doc, swapped.payload);
    expect(reapplied).not.toBeNull();
    expect(reapplied!.children.map((c: { id: string }) => c.id)).toEqual(
      swapped.document.children.map((c: { id: string }) => c.id),
    );
    const expPageA = swapped.document.pages!.find((p) =>
      p.name.toLowerCase().includes('explorations'),
    )!;
    const expPageB = reapplied!.pages!.find((p) =>
      p.name.toLowerCase().includes('explorations'),
    )!;
    expect(expPageB.children.map((c) => c.id).sort()).toEqual(
      expPageA.children.map((c) => c.id).sort(),
    );
  });
});

// =========================================================================
// (b) Fold round-trip
// =========================================================================

describe('hydrateDocumentFromJournal with variant_promote row (fold round-trip)', () => {
  it('reproduces the swapped document + tombstones the removed ids', async () => {
    const mainRoots: PenChild[] = [
      { id: 'main-1', type: 'frame', x: 10, y: 10, width: 50, height: 50 } as unknown as PenChild,
    ];
    const variantRoot = {
      id: 'variant-fold',
      type: 'frame',
      x: 0,
      y: 0,
      width: 200,
      height: 200,
    } as unknown as PenChild;
    const preSwap = buildParkedDoc({
      mainRoots,
      parkedSections: [{ id: 'sec-fold', label: 'Variant', variantRoot }],
    });
    const swapped = swapVariantWithMain(preSwap, 'sec-fold')!;

    await insertCheckpoint(preSwap, 0, 'ckpt-pre');
    seedRow('variant_promote', swapped.payload);

    const h = await hydrateDocumentFromJournal(DOC);
    expect(h.document.children.map((c: { id: string }) => c.id)).toEqual(['variant-fold']);
    const expPage = h.document.pages!.find((p) =>
      p.name.toLowerCase().includes('explorations'),
    )!;
    expect(expPage.children.some((c) => c.id === 'sec-fold')).toBe(false);
    expect(
      expPage.children.some((c) => (c as { name?: string }).name === 'Previous — applied design'),
    ).toBe(true);
    // Tombstones contain the promoted section id + previous main roots.
    expect(h.tombstones.has('sec-fold')).toBe(true);
    expect(h.tombstones.has('main-1')).toBe(true);
  });

  it('is idempotent vs a following document_restore row (swap then restore of identical state)', async () => {
    const mainRoots: PenChild[] = [
      { id: 'main-1', type: 'frame', x: 10, y: 10, width: 50, height: 50 } as unknown as PenChild,
    ];
    const variantRoot = {
      id: 'variant-idem',
      type: 'frame',
      x: 0,
      y: 0,
      width: 200,
      height: 200,
    } as unknown as PenChild;
    const preSwap = buildParkedDoc({
      mainRoots,
      parkedSections: [{ id: 'sec-idem', label: 'Variant', variantRoot }],
    });
    const swapped = swapVariantWithMain(preSwap, 'sec-idem')!;

    await insertCheckpoint(preSwap, 0, 'ckpt-pre2');
    seedRow('variant_promote', swapped.payload);

    // The client's subsequent document:restore journals a snapshot of the
    // identical swapped state.
    const snapshotId = 'snap-post-swap';
    await db.documentSnapshot.create({
      data: {
        id: snapshotId,
        documentId: DOC,
        document: JSON.stringify(swapped.document),
        source: 'restore',
        nodeCount: collectAllNodeIds(swapped.document).length,
        label: 'post-swap restore',
      },
    });
    seedRow('document_restore', { snapshotId });

    const h = await hydrateDocumentFromJournal(DOC);
    expect(h.document.children.map((c: { id: string }) => c.id)).toEqual(['variant-idem']);
  });
});

// =========================================================================
// (c) Route
// =========================================================================

describe('POST /api/documents/[id]/variants/promote (route)', () => {
  it('400 when sectionId is missing or not a string', async () => {
    const res1 = await promotePOST(jsonRequest({}), routeParams(DOC));
    expect(res1.status).toBe(400);
    const body1 = await res1.json();
    expect(body1.error).toMatch(/sectionId/);

    const res2 = await promotePOST(jsonRequest({ sectionId: 42 }), routeParams(DOC));
    expect(res2.status).toBe(400);
  });

  it('409 when a design run is active', async () => {
    registerActiveRun(DOC, { sessionId: 's1' });
    const res = await promotePOST(jsonRequest({ sectionId: 'sec-1' }), routeParams(DOC));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/active/);
  });

  it('404 when the section is not parked (swap returns null)', async () => {
    // A doc with no Explorations page → swap returns null.
    const doc = emptyDocument(DOC);
    (doc as CanvasDocument).pages = [{ id: 'p', name: 'Page 1', children: [] }];
    (doc as CanvasDocument).activePageIndex = 0;
    (doc as CanvasDocument).children = [];
    await insertCheckpoint(doc, 0, 'ckpt-route-404');

    const res = await promotePOST(jsonRequest({ sectionId: 'unknown' }), routeParams(DOC));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not parked|not found/i);
  });

  it('200 with { ok: true, document } on success + journals a variant_promote row', async () => {
    const mainRoots: PenChild[] = [
      { id: 'old-root', type: 'frame', x: 0, y: 0, width: 10, height: 10 } as unknown as PenChild,
    ];
    const variantRoot = {
      id: 'variant-root',
      type: 'frame',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    } as unknown as PenChild;
    const doc = buildParkedDoc({
      mainRoots,
      parkedSections: [{ id: 'sec-1', label: 'Variant B — 7', variantRoot }],
    });
    await insertCheckpoint(doc, 0, 'ckpt-route-200');

    const res = await promotePOST(jsonRequest({ sectionId: 'sec-1' }), routeParams(DOC));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.document).toBeDefined();
    expect(Array.isArray(body.document.pages)).toBe(true);

    // The route journaled a variant_promote row — verify via the mock's rows.
    const vp = stateFold.rows.find(
      (r) => r.documentId === DOC && r.type === 'variant_promote',
    );
    expect(vp).toBeDefined();
    expect((vp!.payload as { promotedSectionId: string }).promotedSectionId).toBe('sec-1');
  });
});
