// GET  /api/documents/[documentId]/snapshots — list a document's canvas
//       snapshots (metadata only — the document JSON is excluded, too large)
// POST /api/documents/[documentId]/snapshots — capture a snapshot
//
// Shared-canvas model (document-first): snapshots belong to the DOCUMENT with
// sessionId/messageId/runId provenance. POST is idempotent by client-supplied
// `id` — same contract as POST /api/sessions (client and server rows share an
// id so later bookmark/label/delete syncs target the same row).

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Cap the list response — the document timeline is shared across every chat
// on the canvas and grows monotonically.
const MAX_SNAPSHOTS_RETURNED = 100;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await params;
  const limitParam = Number(req.nextUrl.searchParams.get('limit') ?? MAX_SNAPSHOTS_RETURNED);
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(Math.trunc(limitParam), 1), 200)
    : MAX_SNAPSHOTS_RETURNED;
  try {
    const snapshots = await db.documentSnapshot.findMany({
      where: { documentId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        documentId: true,
        sessionId: true,
        messageId: true,
        runId: true,
        source: true,
        nodeCount: true,
        label: true,
        bookmarked: true,
        createdAt: true,
        // Don't select the full document JSON for list view — too large. The
        // single-snapshot GET returns it (restore path for remote entries).
      },
    });
    return NextResponse.json({ snapshots });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to list snapshots: ${message}` }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await params;
  const body = await req.json().catch(() => ({}));
  const { id, sessionId, messageId, runId, document, source, nodeCount, label } = body;

  if (typeof id !== 'string' || !id) {
    return NextResponse.json({ error: 'id is required (client snapshot id)' }, { status: 400 });
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return NextResponse.json({ error: 'document must be an object' }, { status: 400 });
  }

  try {
    // Idempotent upsert keyed by the client-supplied id — the client
    // fire-and-forgets captures, so duplicate requests happen. An existing
    // row is returned untouched (captures are append-only and immutable).
    const existing = await db.documentSnapshot.findUnique({ where: { id } });
    if (existing) {
      return NextResponse.json({ snapshot: existing });
    }

    const snapshot = await db.documentSnapshot.create({
      data: {
        id,
        documentId,
        sessionId: sessionId || null,
        messageId: messageId || null,
        runId: runId || null,
        document: JSON.stringify(document),
        source: source || 'turn_end',
        nodeCount: typeof nodeCount === 'number' ? nodeCount : 0,
        label: label || null,
      },
    });

    return NextResponse.json({ snapshot });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to sync snapshot: ${message}` }, { status: 500 });
  }
}
